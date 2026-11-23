/**
 * Corrective notices for root `run_code` programs, judged from what the program did.
 *
 * The shape and shell-bypass rules read the calls the program actually dispatched
 * (recorded from nested `tools/post-execute` events, keyed by `rootCallId`), not the
 * program text, so loops, cursor pagination and waits are classified by their real
 * behaviour. Only two facts never reach the tool layer and are read from the text:
 * the first-line plan comment and direct Node module IO.
 */
import type { Agent } from '../adapter/dsh/types.js'
import type { GuidanceSurface } from './batching-guidance.js'
import { shellFileWork } from './shell-file-work.js'

/** The directive every program opens with: its declared operation list. */
export const PLAN_DIRECTIVE = '// plan:'
/** Notices one agent session receives at most; the lesson already carries the full procedure (#1027). */
export const SESSION_NOTICE_LIMIT = 3

/** Only the first physical line may carry the plan comment, so it is written before the step. */
const PLAN_LINE = /^[\t ]*\/\/\s*plan\s*:\s*(.*)$/u
const PLAN_ENTRY_SEPARATOR = /[;；]/u
/** A real import or require of Node file or process IO; prose mentioning node:fs is not a specifier. */
const MODULE_IO = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"\u0060](?:node:)?(?:fs|fs\/promises|child_process)['"\u0060]/u
const SHELL_TOOL = /^(?:pwsh|bash|shell|ops_bash|pwsh_persistent|bash_persistent)$/u
/** Tools whose call is itself a wait on other work: a dependency barrier, never a wasted round trip. */
const WAITING_TOOL = /^(?:wait_agent|job_output)$/u

/** The file-work APIs the bypass notice names, in the order it names them. */
export const FILE_APIS: readonly string[] = Object.freeze([
  'ops_glob', 'ops_grep', 'ops_read_files', 'ops_inspect_local_file', 'ops_edit_file',
])

/** One tool call a root program dispatched. */
export interface TracedCall {
  readonly name: string
  /** The shell command, when the call carried one. */
  readonly command?: string
  /** Whether the call asked to wait (`wait: true`). */
  readonly waits: boolean
}

/** One finished root program: its text and the calls it made, in completion order. */
export interface ProgramTrace {
  readonly code: unknown
  readonly calls: readonly TracedCall[]
}

/** Read one nested execution into a traced call. */
export function tracedCall(name: string, args: unknown): TracedCall {
  const record = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}
  const command = typeof record.command === 'string' ? record.command : undefined
  return command === undefined ? { name, waits: record.wait === true } : { name, command, waits: record.wait === true }
}

/** Nested calls per root call id, until the root program settles. */
export interface TraceRecorder {
  record(rootCallId: string, call: TracedCall): void
  /** Return and drop the calls recorded under one root. */
  take(rootCallId: string, code: unknown): ProgramTrace
  clear(): void
}

export function createTraceRecorder(): TraceRecorder {
  const calls = new Map<string, TracedCall[]>()
  return {
    record(rootCallId, call) {
      const list = calls.get(rootCallId)
      if (list === undefined) calls.set(rootCallId, [call])
      else list.push(call)
    },
    take(rootCallId, code) {
      const list = calls.get(rootCallId) ?? []
      calls.delete(rootCallId)
      return { code, calls: list }
    },
    clear() { calls.clear() },
  }
}

/**
 * Read the operations a program declared on its first line.
 * @param code - the `run_code` program text.
 * @returns the declared entries; empty when the first line carries no plan comment.
 */
export function parsePlan(code: unknown): string[] {
  if (typeof code !== 'string' || code.length === 0) return []
  const body = code.charCodeAt(0) === 0xfeff ? code.slice(1) : code
  const newline = body.search(/\r?\n/u)
  const match = PLAN_LINE.exec(newline === -1 ? body : body.slice(0, newline))
  if (match === null) return []
  return match[1]!.split(PLAN_ENTRY_SEPARATOR).map(entry => entry.trim()).filter(entry => entry.length > 0)
}

/** Whether a program spent its round trip on exactly one call that was not a wait. */
export function singleCall(trace: ProgramTrace): boolean {
  if (trace.calls.length !== 1) return false
  const [call] = trace.calls
  return !WAITING_TOOL.test(call!.name) && !call!.waits
}

export type BatchingCategory = 'plan' | 'bypass' | 'shape'
/** Delivery priority when one program earns several categories at once. */
export const CATEGORY_PRIORITY: readonly BatchingCategory[] = Object.freeze(['bypass', 'plan', 'shape'])

/**
 * Which categories one program earns.
 *
 * A program that dispatched nothing has no call shape to correct, but module I/O is
 * still a bypass: reading files through `node:fs` needs no tool call at all. The shape category
 * needs two single-call programs in a row in one turn: one short program is often a
 * deliberate probe, while a run of them is the round-trip pattern the notice names.
 * @param trace - the finished program.
 * @param previousSingle - whether the previous root program of this turn made a single call.
 */
export function findingsOf(trace: ProgramTrace, previousSingle: boolean): Record<BatchingCategory, boolean> {
  const text = typeof trace.code === 'string' ? trace.code : ''
  if (trace.calls.length === 0) return { plan: false, bypass: MODULE_IO.test(text), shape: false }
  return {
    plan: parsePlan(trace.code).length === 0,
    bypass: MODULE_IO.test(text)
      || trace.calls.some(call => SHELL_TOOL.test(call.name) && call.command !== undefined && shellFileWork(call.command)),
    shape: previousSingle && singleCall(trace),
  }
}

/** One sentence naming the file-work APIs the scope really publishes. */
export function fileWorkHint(names: readonly string[]): string {
  const usable = FILE_APIS.filter(name => names.includes(name))
  if (usable.length === 0) return 'No OPS file API is available here: do file work with the official tools.'
  if (usable.length === FILE_APIS.length) {
    return 'List with `ops_glob`, search with `ops_grep`, read with `ops_read_files` or `ops_inspect_local_file`, edit with `ops_edit_file`.'
  }
  return 'Do file work with the APIs this scope publishes: `' + usable.join('`, `') + '`.'
}

/** The text one category delivers; each names one fix and only APIs the scope publishes. */
export function noticeText(category: BatchingCategory, surface: GuidanceSurface): string {
  if (category === 'plan') {
    return [
      'Your last program did not open with a plan line.',
      'Start the next program on its first line with `// plan: <operation>; <operation>`, one entry per tool call.',
      'A plan comment further down does not count.',
    ].join('\n')
  }
  if (category === 'bypass') {
    const available = surface.loader ? [...new Set([...surface.resident, ...surface.loadable])] : [...surface.resident]
    const fileUsable = FILE_APIS.filter(name => available.includes(name)).length
    return [
      'Your last program did file work through the shell or Node IO, which bypasses path policy and the audit trail.',
      fileWorkHint(available),
      surface.loader
        ? fileUsable === FILE_APIS.length
          ? 'Use the APIs in the current SDK; load only missing names with `tools.ops_load_sdk` for the next program.'
          : fileUsable === 0
            ? 'The loadable pool holds no file API either, so loading adds nothing here.'
            : 'Load only names this scope publishes with `tools.ops_load_sdk` for the next program; an API outside that pool is not reachable.'
        : fileUsable === 0
          ? 'There is no loader here, and retrying a name will not publish one.'
          : 'There is no loader here: call those APIs directly in the next program.',
    ].join('\n')
  }
  return [
    'Your last two programs each made a single tool call, one round trip per operation.',
    'Put independent operations in one program under `Promise.all`; keep a dependent call as a second `await` in the same program.',
  ].join('\n')
}

/** One notice to deliver, attributed to the category that earned it. */
export interface ProgramNotice {
  readonly category: BatchingCategory
  /** Host turn the notice belongs to; 0 until the host reported one. */
  readonly turn: number
  readonly text: string
}

/** Per-agent latch: each category speaks once until compliance re-arms it, within a session cap. */
export interface ProgramLatch {
  /** Start a host turn: categories re-arm and the single-call run resets. Repeating a turn is a no-op. */
  noteTurn(agent: Agent, turn: number): void
  /** Record one finished program and return the notice it earns, if any. */
  observe(agent: Agent, trace: ProgramTrace): ProgramNotice | undefined
  isArmed(agent: Agent, category: BatchingCategory): boolean
  /** Deliveries this turn and this session, for the optional telemetry line. */
  stats(agent: Agent): { turn: number; plan: number; bypass: number; shape: number; total: number; session: number }
  forget(agent: Agent): void
}

interface LatchState {
  turn: number
  armed: Record<BatchingCategory, boolean>
  sent: Record<BatchingCategory, number>
  session: number
  previousSingle: boolean
}

/**
 * Create the per-agent latch used by the root `run_code` trigger.
 * @param surfaceOf - what the agent's scope publishes, resolved at delivery time.
 * @param options.sessionLimit - notices per agent session; defaults to {@link SESSION_NOTICE_LIMIT}.
 */
export function createProgramLatch(surfaceOf: (agent: Agent) => GuidanceSurface,
  options: { sessionLimit?: number } = {}): ProgramLatch {
  const limit = options.sessionLimit ?? SESSION_NOTICE_LIMIT
  const states = new WeakMap<Agent, LatchState>()
  const rearm = (state: LatchState, turn: number): void => {
    state.turn = turn
    state.armed = { plan: true, bypass: true, shape: true }
    state.sent = { plan: 0, bypass: 0, shape: 0 }
    state.previousSingle = false
  }
  const stateFor = (agent: Agent): LatchState => {
    let state = states.get(agent)
    if (state === undefined) {
      state = { turn: 0, armed: { plan: true, bypass: true, shape: true }, sent: { plan: 0, bypass: 0, shape: 0 }, session: 0, previousSingle: false }
      states.set(agent, state)
    }
    return state
  }
  return {
    noteTurn(agent, turn) {
      const normalised = Number.isSafeInteger(turn) ? turn : 0
      const state = stateFor(agent)
      if (state.turn !== normalised) rearm(state, normalised)
    },
    observe(agent, trace) {
      const state = stateFor(agent)
      const findings = findingsOf(trace, state.previousSingle)
      state.previousSingle = singleCall(trace)
      for (const entry of CATEGORY_PRIORITY) if (!findings[entry]) state.armed[entry] = true
      if (state.session >= limit) return undefined
      const category = CATEGORY_PRIORITY.find(entry => findings[entry] && state.armed[entry])
      if (category === undefined) return undefined
      state.armed[category] = false
      state.sent[category] += 1
      state.session += 1
      // A shape notice covers the run so far; the next single call starts a new run.
      if (category === 'shape') state.previousSingle = false
      return { category, turn: state.turn, text: noticeText(category, surfaceOf(agent)) }
    },
    isArmed(agent, category) { return stateFor(agent).armed[category] },
    stats(agent) {
      const { turn, sent: { plan, bypass, shape }, session } = stateFor(agent)
      return { turn, plan, bypass, shape, total: plan + bypass + shape, session }
    },
    forget(agent) { states.delete(agent) },
  }
}
