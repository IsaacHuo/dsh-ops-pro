/**
 * The sidebar console: wire parsers, the page helpers, the host actions behind
 * the `opsSettings` remote, and a console save restarting the computer-use row
 * with the saved settings.
 *
 * Cost note: cordis plus (on Windows) one fake node child; never the real runtime.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { assert, test, report, PACKAGE_ROOT, TEST_HOME } from './lib/harness.mjs'
import { parseCuSettings, parseDays } from '../lib/settings/console-contract.js'
import { RUNTIME_DESCRIPTORS } from '../lib/settings/runtime-contract.js'
import { fieldLabel, isDirty, nextOverrides, parseField, compact, duration } from '../lib/client/console/model.js'
import { overridesFile, readOverrides, writeOverrides } from '../lib/cu/overrides.js'
import { UsageStore } from '../lib/usage/store.js'
import { publicToolName } from '../lib/policy.js'

const FAKE = path.join(PACKAGE_ROOT, 'test', 'lib', 'fake-cu-server.mjs')
const RUNTIME = mkdtempSync(path.join(TEST_HOME, 'cu-runtime-'))
mkdirSync(path.join(RUNTIME, 'mcp'))
cpSync(path.join(PACKAGE_ROOT, 'lib', 'computer-use', 'mcp'), path.join(RUNTIME, 'mcp'), { recursive: true })
cpSync(FAKE, path.join(RUNTIME, 'mcp', 'server.mjs'))
process.env.DSH_OPS_CU_RUNTIME = RUNTIME
const { ConsoleActions, editableFields } = await import('../lib/settings/console-actions.js')

await test('the remote publishes the console methods and validates their arguments', () => {
  const ids = RUNTIME_DESCRIPTORS.map(descriptor => descriptor.method)
  for (const method of ['console', 'usage', 'resetUsage', 'saveComputerUse']) assert.ok(ids.includes(method), method)
  assert.equal(parseDays(7), 7)
  assert.throws(() => parseDays(31), /between 1 and 30/)
  assert.throws(() => parseDays('7'), /between 1 and 30/)
  assert.deepEqual(parseCuSettings({ browserFirst: false, desktopTarget: 'fast' }), { browserFirst: false, desktopTarget: 'fast' })
  assert.throws(() => parseCuSettings({ enabledTools: ['a'] }), /string, number or boolean/)
  assert.throws(() => parseCuSettings({ '__proto__x': 1 }), /invalid setting key/)
  assert.throws(() => parseCuSettings([]), /settings object/)
})

await test('page helpers pick the locale label, parse inputs and compute the overrides to save', () => {
  assert.equal(fieldLabel('工作方式 / Work mode', 'zh'), '工作方式')
  assert.equal(fieldLabel('工作方式 / Work mode', 'en'), 'Work mode')
  const opacity = { key: 'progressOverlayOpacity', type: 'integer', default: 60, label: 'x', min: 20, max: 100 }
  assert.deepEqual(parseField(opacity, '80'), { value: 80 })
  assert.equal(parseField(opacity, '5').error, '20–100')
  assert.equal(parseField(opacity, '8.5').error, 'an integer')
  assert.equal(parseField({ key: 'b', type: 'enum', values: ['a', 'b'], default: 'a', label: 'b' }, 'c').error, 'one of a, b')
  const view = { status: {}, file: 'f', overrides: ['browserApp'],
    fields: [{ key: 'browserApp', type: 'enum', values: ['default', 'edge'], default: 'default', label: '' }, { key: 'browserFirst', type: 'boolean', default: true, label: '' }],
    values: { browserApp: 'edge', browserFirst: true } }
  assert.equal(isDirty(view, {}), false)
  assert.equal(isDirty(view, { browserFirst: true }), false)
  assert.equal(isDirty(view, { browserFirst: false }), true)
  // An existing console key is kept; an unchanged default is not written.
  assert.deepEqual(nextOverrides(view, { browserFirst: false }), { browserApp: 'edge', browserFirst: false })
  assert.deepEqual(nextOverrides({ ...view, overrides: [] }, {}), {})
  assert.equal(compact(1234), '1.2k'); assert.equal(compact(2_500_000), '2.5M'); assert.equal(compact(12), '12')
  assert.equal(duration(1500), '1.5 s'); assert.equal(duration(12.4), '12 ms')
})

await test('only plain draft settings are editable from the console', async () => {
  const { SETTINGS_SCHEMA } = await import(new URL(`file:///${path.join(RUNTIME, 'mcp', 'settings-schema.mjs').replace(/\\/g, '/')}`).href)
  const keys = editableFields(SETTINGS_SCHEMA).map(field => field.key)
  assert.ok(keys.includes('desktopTarget') && keys.includes('browserFirst') && keys.includes('progressOverlayOpacity'))
  for (const hidden of ['enabledTools', 'mode', 'resumeToken', 'previewToken', 'progressPreviewToken', 'communityNote']) assert.equal(keys.includes(hidden), false, hidden)
})

await test('the console file round-trips, an empty save removes it and a broken file is reported', () => {
  const file = path.join(mkdtempSync(path.join(TEST_HOME, 'cu-file-')), 'dsh-ops', 'computer-use.json')
  assert.deepEqual(readOverrides(file), { settings: {} })
  writeOverrides({ browserFirst: false }, file)
  assert.deepEqual(readOverrides(file).settings, { browserFirst: false })
  writeOverrides({}, file)
  assert.equal(existsSync(file), false)
  mkdirSync(path.dirname(file), { recursive: true })
  writeOverrides({ a: 1 }, file)
  cpSync(FAKE, file)
  const broken = readOverrides(file)
  assert.deepEqual(broken.settings, {})
  assert.match(broken.error, /ignoring/)
  assert.equal(overridesFile({ DSH_HOME: TEST_HOME }), path.join(TEST_HOME, 'dsh-ops', 'computer-use.json'))
})

await test('host actions validate with the vendored rules before writing, then restart', async () => {
  const home = mkdtempSync(path.join(TEST_HOME, 'console-home-'))
  const env = { ...process.env, DSH_HOME: home }
  let restarts = 0
  const usage = new UsageStore(path.join(home, 'usage.json'), () => Date.now())
  usage.record({ tool: publicToolName('read'), ok: true, ms: 5, outputChars: 400, viaCode: false })
  const actions = new ConsoleActions({ env, usage: () => usage, restart: async () => { restarts++; return true },
    config: () => ({ 'computer-use': { enabled: true, settings: { browserApp: 'edge' } } }) })
  const rejected = await actions.saveComputerUse({ progressOverlayOpacity: 5 })
  assert.equal(rejected.status, 'failed'); assert.equal(rejected.effectState, 'none'); assert.match(rejected.message, /between 20 and 100/)
  assert.equal((await actions.saveComputerUse({ enabledTools: 'x' })).message, 'enabledTools cannot be set from the console')
  assert.equal(existsSync(overridesFile(env)), false); assert.equal(restarts, 0)
  const saved = await actions.saveComputerUse({ browserFirst: false })
  assert.equal(saved.status, 'applied'); assert.equal(restarts, 1)
  assert.deepEqual(JSON.parse(readFileSync(overridesFile(env), 'utf8')).settings, { browserFirst: false })
  const snapshot = await actions.snapshot()
  assert.equal(snapshot.version, JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version)
  assert.ok(snapshot.features.some(feature => feature.id === 'computer-use' && feature.enabled))
  // Effective value order: default, then the row's settings, then the console file.
  assert.equal(snapshot.computerUse.values.browserFirst, false)
  assert.equal(snapshot.computerUse.values.browserApp, 'edge')
  assert.equal(snapshot.computerUse.values.desktopTarget, 'quiet')
  assert.deepEqual(snapshot.computerUse.overrides, ['browserFirst'])
  assert.equal(actions.usage(7).calls, 1)
  assert.equal(actions.resetUsage().status, 'applied')
  assert.equal(actions.usage(7).calls, 0)
  const idle = new ConsoleActions({ env, restart: async () => false })
  assert.equal((await idle.saveComputerUse({})).status, 'saved')
  assert.equal(existsSync(overridesFile(env)), false)
})

await test('a console save restarts the computer-use row with the saved settings', async () => {
  if (process.platform !== 'win32') return
  const { apply } = await import('../lib/components/computer-use/index.js')
  const { computerUseStatus, restartComputerUse } = await import('../lib/cu/state.js')
  const registered = new Map()
  const ctx = new Context()
  ctx.provide('tools', { register(definition) { registered.set(definition.name, definition); return () => registered.delete(definition.name) }, definitions: () => [] })
  const ready = async () => {
    const deadline = Date.now() + 15000
    while (computerUseStatus().state !== 'ready' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(computerUseStatus().state, 'ready', computerUseStatus().message)
  }
  writeOverrides({}, overridesFile())
  const fiber = ctx.plugin({ name: 'cu', apply: inner => apply(inner, { settings: { browserApp: 'edge' } }) })
  await fiber
  try {
    await ready()
    const call = async () => (await registered.get(publicToolName('cu_health')).execute({}, { signal: new AbortController().signal })).text
    const before = await call()
    assert.match(before, /"browserFirst":true/)
    assert.match(before, /"browserApp":"edge"/)
    writeOverrides({ browserFirst: false }, overridesFile())
    assert.equal(await restartComputerUse(), true)
    await ready()
    const after = await call()
    assert.match(after, /"browserFirst":false/)
    assert.match(after, /"browserApp":"edge"/)
    assert.notEqual(before.split('pid=')[1], after.split('pid=')[1], 'a fresh process serves the saved settings')
  } finally {
    writeOverrides({}, overridesFile())
    await fiber.dispose()
  }
  assert.equal(await restartComputerUse(), false)
})

await report('console')
