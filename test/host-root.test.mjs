import { assert, test, report } from './lib/harness.mjs'
import { Context } from '@deepseek-ai/cordis'
import { hostRoot, CORDIS_ROOT } from '../lib/adapter/dsh/root.js'
import { joinMode, enabledModes } from '../lib/presets/registry.js'

/** A context shaped like newer cordis (#1026): the root sits under a symbol and a bare `root` read throws. */
function symbolOnlyRoot() {
  const target = { emit() {} }
  const root = new Proxy(target, {
    get(object, prop, receiver) {
      if (prop === 'root') throw new Error('cannot get property "root" without inject')
      return Reflect.get(object, prop, receiver)
    },
  })
  target[CORDIS_ROOT] = root
  return { root, child: () => Object.create(root) }
}

await test('hostRoot reads the symbol root without touching a throwing root property', () => {
  const { root, child } = symbolOnlyRoot()
  assert.equal(CORDIS_ROOT, Symbol.for('cordis.root'))
  assert.equal(hostRoot(child()), root)
  assert.equal(hostRoot(root), root)
})

await test('hostRoot keeps the released cordis root property', () => {
  const ctx = new Context()
  assert.equal(hostRoot(ctx), ctx.root)
  const legacyRoot = { name: 'root' }
  assert.equal(hostRoot({ root: legacyRoot }), legacyRoot)
})

await test('hostRoot falls back to the context itself when it carries no root', () => {
  const bare = {}
  assert.equal(hostRoot(bare), bare)
  const unset = { root: undefined }
  assert.equal(hostRoot(unset), unset)
})

await test('a mode joined on a symbol-root host activates and is shared across the root (#1026)', () => {
  const { child } = symbolOnlyRoot()
  const config = { enabled: true }
  let leave
  assert.doesNotThrow(() => { leave = joinMode(child(), 'standard', config) })
  assert.equal(enabledModes(child()).get('standard'), config)
  leave()
  assert.equal(enabledModes(child()).has('standard'), false)
})

report('host-root')
