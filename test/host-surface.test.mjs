/** The host-surface inventory, its ratchet outside src/adapter/dsh/, and the host-name contract. */
import fs from 'node:fs'
import path from 'node:path'
import {
  compareSurface, hostContract, hostPackageText, inventory, scanHostSurface, summarize, surfaceCounts,
} from '../scripts/lib/host-surface.mjs'
import { assert, test, report, PACKAGE_ROOT } from './lib/harness.mjs'

await test('one scan names events, services, injections and cordis internals with their lines', () => {
  const text = [
    "ctx.on('agent/created', fn)",
    "await ctx.serial('tools/post-execute', x)",
    "const tools = ctx.get('tools')",
    "root.inject(['tools', 'systemPrompt'], apply)",
    "const key = Symbol.for('cordis.root')",
    "map.get(key) // not a string literal: ignored",
  ].join('\n')
  assert.deepEqual(scanHostSurface(text).map(hit => hit.kind + ' ' + hit.name + ' @' + hit.line), [
    'event agent/created @1', 'event tools/post-execute @2', 'service tools @3',
    'inject systemPrompt @4', 'inject tools @4', 'cordis-internal cordis.root @5',
  ])
})

await test('the source inventory groups by name and area and includes the cordis root lookup', () => {
  const rows = summarize(inventory(path.join(PACKAGE_ROOT, 'src')))
  const root = rows.find(row => row.kind === 'cordis-internal' && row.name === 'cordis.root')
  assert.ok(root, 'src/adapter/dsh/root.ts reads the cordis root symbol')
  assert.ok(rows.some(row => row.kind === 'event' && row.name === 'agent/created' && row.areas.length > 1))
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].count >= rows[i].count, 'rows sort by count')
})
await test('the ratchet ignores the adapter and fails both on growth and on an unlowered baseline', () => {
  const hits = [
    { file: 'adapter/dsh/host.ts', kind: 'service', name: 'tools', line: 1 },
    { file: 'shells/tool.ts', kind: 'service', name: 'tools', line: 1 },
    { file: 'shells/tool.ts', kind: 'service', name: 'tools', line: 9 },
  ]
  const counts = surfaceCounts(hits)
  assert.deepEqual(counts, { 'shells/tool.ts': { 'service:tools': 2 } }, 'adapter hits are free')
  assert.deepEqual(compareSurface(counts, counts), { grown: [], shrunk: [] })
  const grown = compareSurface({ 'shells/tool.ts': { 'service:tools': 2, 'event:agent/created': 1 } }, counts).grown
  assert.deepEqual(grown.map(item => item.key + ' ' + item.baseline + '->' + item.current), ['event:agent/created 0->1'])
  const shrunk = compareSurface({ 'shells/tool.ts': { 'service:tools': 1 } }, counts).shrunk
  assert.deepEqual(shrunk.map(item => item.file + ' ' + item.current), ['shells/tool.ts 1'])
})

await test('the committed baseline equals the current source', () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'scripts', 'host-surface-baseline.json'), 'utf8'))
  const { grown, shrunk } = compareSurface(surfaceCounts(inventory(path.join(PACKAGE_ROOT, 'src'))), baseline)
  assert.deepEqual([...grown, ...shrunk], [], 'run node scripts/check-host-surface.mjs')
})

await test('every host name src/ uses exists in the installed host packages or is explained', () => {
  const rows = summarize(inventory(path.join(PACKAGE_ROOT, 'src')))
  const contract = hostContract(rows, hostPackageText(path.join(PACKAGE_ROOT, 'node_modules')))
  assert.deepEqual(contract.missing, [], 'a host name src/ relies on is gone from the installed DSH packages')
  assert.deepEqual(contract.unused, [], 'NON_HOST_NAMES explains names src/ no longer uses')
  const renamed = hostContract([{ kind: 'event', name: 'agent/created-renamed', count: 1, areas: [] }], "on('agent/created')", {})
  assert.deepEqual(renamed.missing, ['event:agent/created-renamed'], 'a renamed host event is reported')
})
report('host-surface')
