/** Prompt-prefix stability across one session's ordinary progress (R0).
 *
 * Provider prompt caches key on the leading bytes of the request. Every mode is
 * driven through the moves a real session makes — first step, a progressive
 * selection (native discovery or the PTC SDK loader), the next step, and the next
 * turn — and every system-prompt section must stay byte-identical. Selection may
 * change declarations only (#975); the one known exception is listed in SELECTION_REWRITES. Section sizes are printed as one JSON line per
 * mode so size drift is visible in gate logs.
 */
import { createScope, scopeOf, scopeParentOf } from '@deepseek-ai/dsh-scope'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import { apply } from '../lib/index.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { prepareStep, executeCall, selectExecutor } from './lib/executor.mjs'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'

requireWorker('prefix-stability')
let sequence = 0
const MODES = ['minimal', 'standard', 'ptc', 'ops-ptc']
// Known cache break, locked until R3: the host renders tools:sdk from the callable set, so a
// PTC load inserts the loaded declaration mid-section (grep: +10 KB at byte ~3.9 K). R3 declares
// the loadable pool up front; this list then becomes empty.
const SELECTION_REWRITES = { minimal: [], standard: [], ptc: ['tools:sdk'], 'ops-ptc': ['tools:sdk'] }

async function scoped(parent, key, parentKey) {
  let result
  await parent.plugin({ inject: ['tools'], apply(inner) {
    result = createScope(inner, key, parentKey ? { parent: parentKey } : undefined).ctx
  } })
  return result
}

async function step(ctx, agent, turn) {
  ctx.emit('session/event', agent.session, { type: 'step/end', turn, step: ++sequence })
  agent.prepared?.dispose(); agent.prepared = await prepareStep(ctx, agent)
  return new Map(agent.prepared.assembly.sections.filter(row => row.text).map(row => [row.name, row.text]))
}

async function setup(cwd, mode) {
  const { ctx } = await bootHost({ withWorkingDirectory: true })
  await ctx.plugin(Subprocess); await ctx.plugin(Sandbox); await ctx.plugin(FileSystem); await ctx.plugin(NodePtc)
  ctx.provide('sandboxPolicy', { resolve: ({ session } = {}) => ({ mode: session?.mode ?? 'workspace-write', workspaceRoot: cwd, sessionId: session?.id }) })
  const presets = new Map(), agents = []
  ctx.provide('agents', { list: () => [...agents] })
  ctx.provide('agentPresets', { composedPreset: inner => presets.get(scopeParentOf(scopeOf(inner))) })
  const config = { discovery: { binaryPath: WORKER, required: true } }
  for (const id of [...MODES, 'cordis']) config[id] = { enabled: id === mode, binaryPath: WORKER, required: true, bashPath: process.execPath }
  await ctx.plugin({ name: 'prefix-stability-fixture', apply: inner => apply(inner, config) })
  const id = 'prefix-' + ++sequence, preset = await scoped(ctx, { preset: id })
  presets.set(scopeOf(preset), mode)
  for (const name of ['read', 'glob', 'grep']) preset.tools.register({ name, description: name,
    parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) })
  const agent = { id, session: { id, mode: 'workspace-write', header: { cwd }, append() {}, read() { return [] } } }
  agent.ctx = await scoped(preset, agent, scopeOf(preset))
  if (mode.endsWith('ptc')) await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply: inner => { selectExecutor(inner, 'ptc') } })
  agents.push(agent)
  await ctx.serial('agent/created', { agent })
  return { ctx, agent }
}

const names = (ctx, agent) => ctx.get('tools').definitions(agent, agent.prepared.toolSet).map(tool => tool.name)
const call = (ctx, agent, name, args) => executeCall(ctx, { agent, toolSet: agent.prepared.toolSet, name,
  arguments: args, callId: 'prefix-' + ++sequence, signal: new AbortController().signal })

/** Progress one session by one selection; returns the name that must now be declared. */
async function select(ctx, agent, mode) {
  if (mode.endsWith('ptc')) {
    const run = await call(ctx, agent, 'run_code', { description: 'Load grep', code: "return await tools.ops_load_sdk({ tools: ['grep'] })" })
    assert.equal(run.isError, false, JSON.stringify(run))
    return 'ops_grep'
  }
  const picked = await call(ctx, agent, 'ops_discover_tools', { query: 'select:ops_write_file' })
  assert.deepEqual(picked.value?.activated, ['ops_write_file'], JSON.stringify(picked))
  return 'ops_write_file'
}

function assertSame(mode, moment, before, after, allowed = []) {
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter(name => before.get(name) !== after.get(name))
  assert.deepEqual(changed, allowed, mode + ': ' + moment + ' rewrote system-prompt sections ' + changed.join(', '))
}

for (const mode of MODES) {
  await test(mode + ': selection, the next step and the next turn keep every prompt section byte-identical', () => withTempDir('prefix-' + mode, async cwd => {
    const { ctx, agent } = await setup(cwd, mode)
    try {
      const first = await step(ctx, agent, 1)
      const expected = await select(ctx, agent, mode)
      assert.equal(names(ctx, agent).includes(expected), false, mode + ': ' + expected + ' is not declared before the next step')
      const selected = await step(ctx, agent, 1)
      assert.ok(names(ctx, agent).includes(expected), mode + ': ' + expected + ' is declared after the selection')
      assertSame(mode, 'selection', first, selected, SELECTION_REWRITES[mode])
      assertSame(mode, 'the next turn', selected, await step(ctx, agent, 2))
      const sections = Object.fromEntries([...first].map(([name, text]) => [name, Buffer.byteLength(text)]))
      console.log(JSON.stringify({ prefixBytes: { mode, platform: process.platform, sections } }))
    } finally { agent.prepared?.dispose(); await shutdown(ctx) }
  }))
}
report('prefix-stability')
