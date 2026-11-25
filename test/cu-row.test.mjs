/**
 * The computer-use row: name mapping, config, the server lifecycle against a
 * fake server, returned failures, approval wiring, and the composition root
 * publishing ops_cu_* beside every mode.
 *
 * Cost note: cordis plus a fake node child; never the real desktop runtime.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { assert, test, report, PACKAGE_ROOT, TEST_HOME } from './lib/harness.mjs'
import { publicCuName, upstreamCuName, isStandaloneCuName } from '../lib/cu/names.js'
import { resolveComputerUseConfig, DEFAULT_CALL_TIMEOUT_MS } from '../lib/cu/config.js'
import { ComputerUseServer } from '../lib/cu/server.js'
import { installApproval } from '../lib/cu/approval.js'
import { resolveMergedConfig, hostConfig } from '../lib/settings/merged.js'
import { publicToolName } from '../lib/policy.js'
import { MODE_IDS } from '../lib/presets/types.js'

const FAKE = path.join(PACKAGE_ROOT, 'test', 'lib', 'fake-cu-server.mjs')
// The row reads its runtime directory when first imported, so point it at a
// fake assembled runtime (the vendored modules plus the fake server) up front.
const RUNTIME = mkdtempSync(path.join(TEST_HOME, 'cu-runtime-'))
mkdirSync(path.join(RUNTIME, 'mcp'))
cpSync(path.join(PACKAGE_ROOT, 'lib', 'computer-use', 'mcp'), path.join(RUNTIME, 'mcp'), { recursive: true })
cpSync(FAKE, path.join(RUNTIME, 'mcp', 'server.mjs'))
process.env.DSH_OPS_CU_RUNTIME = RUNTIME
const spec = (mode, extra = {}) => () => ({ command: process.execPath, args: [FAKE], env: { ...process.env, FAKE_CU_MODE: mode, ...extra } })

await test('server names map both ways and keep the ops_ prefix', () => {
  assert.equal(publicCuName('windows_computer_use_click'), publicToolName('cu_click'))
  assert.equal(upstreamCuName(publicToolName('cu_click')), 'windows_computer_use_click')
  assert.equal(publicCuName('not_a_cu_tool'), undefined)
  assert.equal(upstreamCuName(publicToolName('bash')), undefined)
  assert.equal(isStandaloneCuName('mcp__wincu__windows_computer_use_click'), true)
  assert.equal(isStandaloneCuName(publicToolName('cu_click')), false)
})

await test('the section validates its own keys and defaults off', () => {
  assert.deepEqual(resolveComputerUseConfig(undefined), { settings: {}, callTimeoutMs: DEFAULT_CALL_TIMEOUT_MS })
  assert.throws(() => resolveComputerUseConfig({ timeout: 1 }), /unknown computer-use key "timeout"/)
  assert.throws(() => resolveComputerUseConfig({ callTimeoutMs: 10 }), /callTimeoutMs/)
  assert.throws(() => resolveComputerUseConfig({ settings: { mode: { nested: true } } }), /settings\.mode/)
  const merged = resolveMergedConfig({})
  assert.equal(merged['computer-use'].enabled, false)
  const saved = hostConfig({ 'computer-use': { enabled: true, settings: { mode: 'background' } } })
  assert.deepEqual(saved['computer-use'], { enabled: true, settings: { mode: 'background' } })
  const shipped = readFileSync(path.join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(shipped, /computer-use:\n\s+enabled: false\n\s+callTimeoutMs: 90000\n/)
})

await test('the server starts once, lists tools and answers calls', async () => {
  const server = new ComputerUseServer(spec('normal'), '1.1.0')
  try {
    const tools = await server.listTools()
    assert.deepEqual(tools.map(tool => tool.name).slice(0, 2), ['windows_computer_use_click', 'windows_computer_use_health'])
    const first = await server.call('windows_computer_use_click', { elementId: 'a' }, { timeoutMs: 5000 })
    const second = await server.call('windows_computer_use_health', {}, { timeoutMs: 5000 })
    assert.match(first.content[0].text, /^windows_computer_use_click \{"elementId":"a"\}/)
    // One persistent process serves every call.
    assert.equal(first.content[0].text.split('pid=')[1], second.content[0].text.split('pid=')[1])
    assert.equal(server.snapshot().state, 'running')
    assert.equal(server.snapshot().starts, 1)
  } finally { await server.dispose() }
})

await test('a crashing server is restarted once, then stays down with the reason', async () => {
  const server = new ComputerUseServer(spec('crash-on-call'), '1.1.0')
  try {
    await assert.rejects(server.call('windows_computer_use_click', {}, { timeoutMs: 5000 }), error => error.code === 'RPC_EXITED')
    await assert.rejects(server.call('windows_computer_use_click', {}, { timeoutMs: 5000 }), error => error.code === 'RPC_EXITED')
    await assert.rejects(server.ready(), /stopped twice/)
    assert.equal(server.snapshot().state, 'failed')
    assert.equal(server.snapshot().starts, 2)
  } finally { await server.dispose() }
})

await test('a hung call times out and reaches the caller as a returned failure', async () => {
  const { toolDefinition } = await import('../lib/components/computer-use/index.js')
  const server = new ComputerUseServer(spec('hang'), '1.1.0')
  try {
    const [tool] = await server.listTools()
    const definition = toolDefinition(tool, server, { settings: {}, callTimeoutMs: 1000 })
    assert.equal(definition.name, publicToolName('cu_click'))
    const value = await definition.execute({}, { signal: new AbortController().signal })
    assert.equal(value.status, 'failed')
    assert.equal(value.error.code, 'CU_TIMEOUT')
    assert.equal(value.error.effectState, 'unknown')
  } finally { await server.dispose() }
})

await test('a tool error is a failed value, never a throw', async () => {
  const { toolDefinition } = await import('../lib/components/computer-use/index.js')
  const server = new ComputerUseServer(spec('tool-error'), '1.1.0')
  try {
    const [tool] = await server.listTools()
    const value = await toolDefinition(tool, server, { settings: {}, callTimeoutMs: 5000 }).execute({}, { signal: new AbortController().signal })
    assert.equal(value.status, 'failed')
    assert.equal(value.error.code, 'CU_TOOL_ERROR')
  } finally { await server.dispose() }
})

await test('approval asks for risky calls and mints a grant bound to the approved arguments', async () => {
  const minted = []
  const policy = {
    parseArguments: value => ({ ...(value ?? {}) }),
    classifyOperation: name => ({ kind: name.endsWith('_click') ? 'ask' : 'allow' }),
    mintGrant: (name, args) => { minted.push([name, args]); return 'grant' },
    sessionSkipsApproval: () => false,
  }
  const ctx = new Context()
  installApproval(ctx, policy, { secret: 's', env: () => ({}), locale: () => 'en' })
  const allow = () => Promise.resolve({ kind: 'allow' })
  const click = { name: publicToolName('cu_click'), arguments: { elementId: 'a' } }
  assert.equal((await ctx.waterfall('tools/pre-execute', click, allow)).kind, 'ask')
  let seen
  await ctx.waterfall('tools/execute', click, () => { seen = { ...click.arguments }; return Promise.resolve({}) })
  assert.equal(seen._wcuApproval, 'grant')
  assert.deepEqual(minted, [['windows_computer_use_click', { elementId: 'a' }]])
  assert.deepEqual(click.arguments, { elementId: 'a' })
  const forged = { name: publicToolName('cu_health'), arguments: { _wcuApproval: 'x' } }
  assert.equal((await ctx.waterfall('tools/pre-execute', forged, allow)).kind, 'deny')
  const other = { name: publicToolName('bash'), arguments: {} }
  assert.equal((await ctx.waterfall('tools/pre-execute', other, allow)).kind, 'allow')
})

await test('the composition root publishes ops_cu_* globally and no mode denies them', async () => {
  if (process.platform !== 'win32') {
    const { apply } = await import('../lib/components/computer-use/index.js')
    const { computerUseStatus } = await import('../lib/cu/state.js')
    const ctx = new Context()
    await ctx.plugin({ name: 'cu', apply: inner => apply(inner, {}) })
    assert.equal(computerUseStatus().state, 'unsupported')
    return
  }
  const { apply } = await import('../lib/index.js')
  const { computerUseStatus } = await import('../lib/cu/state.js')
  const registered = []
  const denied = []
  const base = {
    register(definition) { registered.push(definition.name); return () => {} },
    restrict(rule) { denied.push(...(rule?.deny ?? [])); return () => {} },
    definitions: () => registered.map(name => ({ name })),
    schemas: () => [],
    get() {},
  }
  const tools = new Proxy(base, { get: (target, key) => key in target ? target[key] : () => () => {} })
  const ctx = new Context()
  ctx.provide('tools', tools)
  const fiber = ctx.plugin({ name: 'row', apply: inner => apply(inner, { 'computer-use': { enabled: true } }) })
  await fiber
  const deadline = Date.now() + 15000
  while (computerUseStatus().state !== 'ready' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  const status = computerUseStatus()
  assert.equal(status.state, 'ready', status.message)
  assert.deepEqual(status.tools, [publicToolName('cu_click'), publicToolName('cu_health')])
  assert.equal(status.backendMissing, true)
  for (const name of status.tools) assert.ok(registered.includes(name), `${name} registered`)
  // Every built-in mode mounted, and none of them masks the computer-use tools.
  assert.ok(MODE_IDS.length >= 5)
  for (const name of denied) assert.equal(String(name).startsWith(publicToolName('cu_')), false, `a mode denied ${name}`)
  await fiber.dispose()
  assert.equal(computerUseStatus().state, 'disabled')
})

await report('computer-use row')
