/** The host-surface inventory finds every kind of host touch point it claims to (R0). */
import path from 'node:path'
import { scanHostSurface, inventory, summarize } from '../scripts/lib/host-surface.mjs'
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
report('host-surface')
