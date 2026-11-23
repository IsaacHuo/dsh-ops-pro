/**
 * The model-facing batch-call lesson: loading and rendering it for one scope's surface.
 *
 * The guidance text lives in an editable Markdown file (prompts/batching-guidance.md)
 * so wording changes never require a code change. The module imports no host
 * values, so a unit test can drive it with plain objects and a fake agent. The
 * caller owns delivery; the corrective notices live in batching-notices.ts.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Agent, SandboxMode } from '../adapter/dsh/types.js'

/** Identity of the guidance in the host message source. */
export const BATCHING_GUIDANCE_ID = 'batching-guidance'
/** Revision of the guidance text; bump it when the wording or the file format changes. */
export const BATCHING_GUIDANCE_REVISION = '9'
/**
 * Host source kind for guidance delivered as a user-role message.
 *
 * The message keeps `role: 'user'`, so the model still reads it as the
 * instruction that governs the task. The plugin kind is what tells the client
 * this injection is not human input: Chat files an unknown kind under its
 * producer and draws no user bubble for it.
 */
export const BATCHING_GUIDANCE_SOURCE_KIND = 'dsh-ops:batching-guidance'

// Merge-extensible host sum type: declare the producer's own kind once, so
// createUserMessage accepts it without widening the host's known sources.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-ops:batching-guidance': {
      readonly kind: 'dsh-ops:batching-guidance'
      readonly contributor: string
      readonly revision: string
      readonly turn: number
      readonly step: number
    }
  }
}

/** The shipped guidance file, resolved from this module's own location (src or lib). */
const DEFAULT_GUIDANCE_FILE = new URL('../../prompts/batching-guidance.md', import.meta.url)

/** Loaded text by absolute location; a failed load caches '' instead of retrying. */
const loaded = new Map<string, string>()
let warned = false
/** Reported once: the shipped file lost the anchor the loader-less rendering rewrites. */
let warnedAnchor = false

/** Report an unreadable guidance file once, never once per agent or call. */
function warnUnavailable(location: string, error: unknown): void {
  if (warned) return
  warned = true
  console.warn('dsh-ops: batching guidance is unavailable at ' + location + '; guidance is skipped. ' + String(error))
}

/**
 * Load the batch-call guidance from an editable Markdown file.
 * The file is read once per location and cached; an unreadable or empty file
 * yields '' so delivery is skipped instead of failing a tool result.
 * @param filePath - optional override location (absolute path or file URL).
 * @returns the trimmed guidance text, or '' when it cannot be read.
 */
export function loadBatchingGuidance(filePath?: string | URL): string {
  let location: string
  try {
    location = path.resolve(filePath instanceof URL ? fileURLToPath(filePath)
      : filePath ?? fileURLToPath(DEFAULT_GUIDANCE_FILE))
  } catch (error) {
    warnUnavailable(String(filePath), error)
    return ''
  }
  const cached = loaded.get(location)
  if (cached !== undefined) return cached
  try {
    const text = readFileSync(location, 'utf8').trim()
    loaded.set(location, text)
    return text
  } catch (error) {
    loaded.set(location, '')
    warnUnavailable(location, error)
    return ''
  }
}

/**
 * What one PTC scope actually publishes, in public tool names.
 *
 * The guidance file teaches progressive disclosure, and its loader lesson assumes
 * `ops_load_sdk` is reachable. The loader is only published while dynamic loading is
 * on, so the same text must not reach a scope that has none: it would spend a round
 * trip in that scope on a call that cannot succeed.
 */
export interface GuidanceSurface {
  /** Whether the scope publishes `ops_load_sdk`. */
  readonly loader: boolean
  /** Public names the scope publishes without loading. */
  readonly resident: readonly string[]
  /** Public names the loader can add, empty when the scope publishes no loader. */
  readonly loadable: readonly string[]
  /**
   * The session's current sandbox mode, read from the host policy.
   *
   * When present, the lesson states this mode and keeps only its own tier; when
   * absent, the shipped three-tier lesson is delivered unchanged.
   */
  readonly sandbox?: SandboxMode
}

/**
 * Drop every section whose heading names loading.
 *
 * The fallback path runs when the shipped file no longer carries the anchor: a
 * renamed heading still leaves the old lesson in place, and pairing it with the
 * replacement would put two contradicting steps in one document.
 * @param rows - guidance lines.
 * @returns the lines without loader-named sections.
 */
function dropLoadSections(rows: readonly string[]): string[] {
  const kept: string[] = []
  let dropping = false
  let fence: string | null = null
  for (const row of rows) {
    if (fence !== null) {
      if (row.trim().startsWith(fence)) fence = null
      if (!dropping) kept.push(row)
      continue
    }
    const opening = /^\s*(```+|~~~+)/.exec(row)
    if (opening !== null) {
      fence = opening[1]!
      if (!dropping) kept.push(row)
      continue
    }
    // A heading inside a fence is example text, and only a word that means loading may
    // drop a section: "payload", "download" and "workload" are ordinary prose.
    if (row.startsWith('## ')) dropping = LOAD_HEADING.test(row)
    if (!dropping) kept.push(row)
  }
  return kept
}

/**
 * Remove every trace of the load step from the lines that stay in the document.
 *
 * A fenced block is dropped as a unit when it teaches loading: deleting the call and
 * keeping the lines that consumed the loaded names would ship a half example that a
 * model can copy.
 * @param rows - guidance lines outside the replaced section.
 * @returns the lines without the load step.
 */
function stripLoader(rows: readonly string[]): string[] {
  const kept: string[] = []
  let fence: string | null = null
  let block: string[] = []
  for (const row of rows) {
    if (fence === null) {
      const opening = /^\s*(```+|~~~+)/.exec(row)
      if (opening !== null) {
        fence = opening[1]!
        block = [row]
        continue
      }
      if (row.startsWith(LOAD_TABLE_ROW_PREFIX)) continue
      if (row.includes('ops_load_sdk')) continue
      // The Step 1 prose advertises the same entry without naming the loader tool, so
      // it must not survive beside a replacement section that says there is no loader.
      if (row.includes(LOAD_PROSE_ANCHOR)) continue
      kept.push(row)
      continue
    }
    block.push(row)
    if (row.trim().startsWith(fence)) {
      if (!block.some(line => line.includes('ops_load_sdk'))) kept.push(...block)
      fence = null
      block = []
    }
  }
  // An unterminated fence keeps its lines: dropping the tail of a drifted file would
  // hide more than the load step.
  kept.push(...block)
  return kept
}

/** The heading that starts the loader lesson in the guidance file. */
export const LOAD_SECTION_HEADING = '## Step 3 - load before you call'
/** The heading that starts the sandbox-authority lesson in the guidance file. */
export const SANDBOX_SECTION_HEADING = '## Sandbox permissions'
/** A heading that names loading, by word: "payload" is not a load step. */
const LOAD_HEADING = /\bload(?:ing|er)?\b/i

/** The one table row that teaches the loader. */
export const LOAD_TABLE_ROW_PREFIX = '| ops_read_files before it is loaded'
/** The opening words of the Step 1 prose that teaches SDK loading without the tool name. */
export const LOAD_PROSE_ANCHOR = 'SDK loading'

/**
 * The path caveat for a loader-less scope that cannot discover paths.
 *
 * `ops_inspect_local_file` reads one file by exact path and rejects directories, so a
 * scope that publishes it without `ops_glob` or `ops_grep` must say where the paths
 * come from: a model that probes a directory through it spends a failed round trip.
 * @param resident - public names the scope publishes without loading.
 * @returns the caveat lines, empty when a listing or search API is published.
 */
function exactPathNote(resident: readonly string[]): string[] {
  if (!resident.includes('ops_inspect_local_file') || resident.includes('ops_glob') || resident.includes('ops_grep')) return []
  return [
    '',
    'File work here has no listing and no search API: `ops_inspect_local_file` reads one',
    'file by its exact path and rejects directories, so call it with concrete file paths',
    'you already know.',
  ]
}

/**
 * The section that replaces the loader lesson when the scope publishes no loader.
 * @param surface - what the scope publishes.
 * @returns the replacement lines, heading included.
 */
function directSteps(surface: GuidanceSurface): string[] {
  if (surface.resident.length === 0) {
    return [
      '## Step 3 - what this scope publishes',
      '',
      'This scope publishes no OPS API and no loader. Work with the official tools;',
      'an `ops_*` name outside the SDK is not available here, and retrying will not',
      'make one appear.',
    ]
  }
  return [
    '## Step 3 - call what is published',
    '',
    'This scope publishes no loader: every API already in the SDK is callable directly,',
    'and a name outside it is not available. Calling what you already have is the whole',
    'step, with no load to spend a program on:',
    '',
    '`' + surface.resident.join('`, `') + '`',
    ...exactPathNote(surface.resident),
  ]
}

/**
 * The index of the heading that ends the section starting at `start`.
 * @param lines - the guidance lines.
 * @param start - the section heading index.
 * @returns the next heading index, or the line count when the section is last.
 */
/**
 * The index of one exact heading line, ignoring anything inside a fence.
 *
 * A fenced example that quotes the heading is text, not structure: taking it for the
 * anchor would cut the document in the wrong place.
 * @param lines - the guidance lines.
 * @param heading - the exact heading line to find.
 * @returns the heading index, or -1 when the file lost it.
 */
function headingIndex(lines: readonly string[], heading: string): number {
  let fence: string | null = null
  for (let index = 0; index < lines.length; index += 1) {
    const row = lines[index]!
    if (fence !== null) {
      if (row.trim().startsWith(fence)) fence = null
      continue
    }
    const opening = /^\s*(```+|~~~+)/.exec(row)
    if (opening !== null) {
      fence = opening[1]!
      continue
    }
    if (row.trim() === heading) return index
  }
  return -1
}

/** The index of the load-step heading; -1 when the file lost it. */
function anchorIndex(lines: readonly string[]): number {
  return headingIndex(lines, LOAD_SECTION_HEADING)
}

function nextHeading(lines: readonly string[], from: number): number {
  let fence: string | null = null
  for (let index = from; index < lines.length; index += 1) {
    const row = lines[index]!
    if (fence !== null) {
      if (row.trim().startsWith(fence)) fence = null
      continue
    }
    const opening = /^\s*(```+|~~~+)/.exec(row)
    if (opening !== null) {
      fence = opening[1]!
      continue
    }
    if (row.startsWith('## ')) return index
  }
  return lines.length
}

/**
 * The index of the heading that ends the section starting at `start`.
 * @param lines - the guidance lines.
 * @param start - the section heading index.
 * @returns the next heading index outside any fence, or the line count.
 */
function sectionEnd(lines: readonly string[], start: number): number {
  return nextHeading(lines, start + 1)
}

/**
 * The sandbox lesson for the mode the host reports.
 *
 * The shipped file carries all three tiers because it is also delivered without a
 * host policy; when the mode is known, only the active tier's rule is kept, so a
 * full-access session is never primed with a request it must not make.
 * @param mode - the session's current sandbox mode.
 * @returns the replacement lines, heading included.
 */
function sandboxLesson(mode: SandboxMode): string[] {
  const common = [
    '`sandbox_permissions` accepts only `workspace-write` or `danger-full-access`, and',
    '`justification` must accompany it. Never invent a tier name: an invalid value rejects',
    'the whole program before any line runs.',
    '',
  ]
  switch (mode) {
    case 'read-only':
      return [SANDBOX_SECTION_HEADING + ' - current mode: read-only', '', ...common,
        'This session runs at read-only: reads and searches only. To write, send',
        '`sandbox_permissions: \"workspace-write\"` (or `\"danger-full-access\"`) with a',
        '`justification`.']
    case 'workspace-write':
      return [SANDBOX_SECTION_HEADING + ' - current mode: workspace-write', '', ...common,
        'This session runs at workspace-write: work inside the workspace needs no request.',
        'Send `sandbox_permissions: \"danger-full-access\"` with a `justification` only to',
        'leave the workspace.']
    default:
      return [SANDBOX_SECTION_HEADING + ' - current mode: danger-full-access', '', ...common,
        'This session runs at the widest tier: never send `sandbox_permissions` or',
        '`justification`. No wider target exists, and any value would invent one.']
  }
}

/** Reported once: the shipped file lost the sandbox anchor the renderer rewrites. */
let warnedSandboxAnchor = false

/**
 * Replace the sandbox section with the lesson for the reported mode.
 *
 * A drifted file keeps its lesson: the replacement is inserted before the first
 * section rather than dropped, and the drift is reported once.
 * @param text - the guidance file.
 * @param mode - the session's current sandbox mode.
 * @returns the file with the active tier substituted.
 */
function replaceSandboxLesson(text: string, mode: SandboxMode): string {
  const lines = text.split('\n')
  const replacement = sandboxLesson(mode)
  const start = headingIndex(lines, SANDBOX_SECTION_HEADING)
  if (start < 0) {
    if (!warnedSandboxAnchor) {
      warnedSandboxAnchor = true
      console.warn('dsh-ops: the batching guidance lost its "' + SANDBOX_SECTION_HEADING
        + '" anchor; the sandbox lesson is inserted before the first section instead.')
    }
    const at = nextHeading(lines, 0)
    return [...lines.slice(0, at), ...replacement, '', ...lines.slice(at)].join('\n')
  }
  return [...lines.slice(0, start), ...replacement, '', ...lines.slice(sectionEnd(lines, start))].join('\n')
}

/**
 * Replace the load step for a scope that publishes no loader.
 *
 * The default path does not call this: a loader scope keeps the shipped file
 * byte for byte unless the sandbox lesson was also substituted. A loader-less scope
 * cannot load, so the prose and the table row that teach loading are removed.
 * @param text - the loaded guidance file.
 * @param surface - what the scope publishes.
 * @returns the model-facing guidance text.
 */
function replaceLoaderLesson(text: string, surface: GuidanceSurface): string {
  const lines = text.split('\n')
  const start = anchorIndex(lines)
  // Lines that teach loading, and the table row that points at it, never reach a
  // scope without a loader. The replacement is inserted after this filter, so the
  // filter can never eat the section it was built to produce.
  if (start < 0) {
    // A drifted file is a plugin defect, not a model-facing surprise: say so once,
    // then still keep the lesson free of an unreachable call.
    if (!warnedAnchor) {
      warnedAnchor = true
      console.warn('dsh-ops: the batching guidance lost its "' + LOAD_SECTION_HEADING
        + '" anchor; the load step is replaced before the first section instead.')
    }
    const body = dropLoadSections(stripLoader(lines))
    const at = nextHeading(body, 0)
    return [...body.slice(0, at), ...directSteps(surface), '', ...body.slice(at)].join('\n')
  }
  // Insert the replacement exactly where the load step stood, so the document keeps
  // its heading order and the shared sections keep their positions.
  const before = stripLoader(lines.slice(0, start))
  const after = stripLoader(lines.slice(sectionEnd(lines, start)))
  return [...before, ...directSteps(surface), '', ...after].join('\n')
}

/**
 * Render the guidance for one published surface.
 *
 * A scope with the loader receives the shipped file unchanged unless the host
 * reports a sandbox mode, in which case only the active tier's rule is kept. A
 * loader-less scope additionally receives the same lesson with the load step
 * replaced: the prose that tells the model to load cannot be true there.
 * @param text - the loaded guidance file.
 * @param surface - what the scope publishes.
 * @returns the model-facing guidance text.
 */
export function renderBatchingGuidance(text: string, surface: GuidanceSurface): string {
  if (text === '') return text
  const withSandbox = surface.sandbox === undefined ? text : replaceSandboxLesson(text, surface.sandbox)
  return surface.loader ? withSandbox : replaceLoaderLesson(withSandbox, surface)
}
