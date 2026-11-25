/** The sidebar console page in a real DOM: tabs, status facts, the settings save path and usage reset. */
import { JSDOM } from 'jsdom'
import { assert, test, report } from './lib/harness.mjs'
import { en } from '../lib/client/console/locales.js'
import { ConsolePage } from '../lib/client/console/page.js'
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
for (const name of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent']) globalThis[name] = dom.window[name]
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const t = key => en[key] ?? key
const ok = value => ({ ok: true, value })

const fields = [
  { key: 'browserFirst', type: 'boolean', default: true, label: '网页优先 / Prefer browser use' },
  { key: 'progressOverlayOpacity', type: 'integer', default: 60, min: 20, max: 100, label: '不透明度 / Overlay opacity (%)' },
]
const snapshot = (values = { browserFirst: true, progressOverlayOpacity: 60 }, overrides = []) => ({
  version: '1.1.0', platform: 'win32', features: [{ id: 'ptc', enabled: true }, { id: 'computer-use', enabled: true }, { id: 'tui', enabled: false }],
  worker: { available: true, detail: 'C:/w.exe' },
  computerUse: { status: { state: 'ready', tools: ['ops_cu_click'], conflict: true, backendMissing: true, server: { state: 'running', starts: 1 } },
    fields, values, overrides, file: 'C:/home/dsh-ops/computer-use.json' },
})
const usage = { days: 7, from: '2026-11-19', to: '2026-11-25', calls: 1234, failed: 2, outputChars: 4000, estimatedTokens: 1000,
  daily: [{ day: '2026-11-25', calls: 3, failed: 0 }], tools: [{ tool: 'ops_read', calls: 3, failed: 0, viaCode: 1, outputChars: 400, estimatedTokens: 100, p50Ms: 4, p95Ms: 1500 }] }

async function mount(api) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(h(ConsolePage, { api, t })))
  await act(async () => {})
  return { container, close: async () => { await act(async () => root.unmount()); container.remove() } }
}
const click = element => act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
const tab = (container, label) => [...container.querySelectorAll('[role=tab]')].find(element => element.textContent === label)

await test('the status tab shows host facts and both computer-use warnings', async () => {
  const page = await mount({ console: async () => ok(snapshot()), usage: async () => ok(usage), resetUsage: async () => ok({}), saveComputerUse: async () => ok({}) })
  try {
    const text = page.container.textContent
    assert.match(text, /v1\.1\.0/)
    assert.match(text, /ptc, computer-use/)
    assert.doesNotMatch(text, /tui/)
    assert.match(text, new RegExp(en.cuConflict.slice(0, 30)))
    assert.match(text, new RegExp(en.cuBackendMissing.slice(0, 30)))
    assert.equal(tab(page.container, en.tabStatus).getAttribute('aria-selected'), 'true')
    // Arrow keys move the selection.
    await act(async () => { page.container.querySelector('[role=tablist]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    assert.equal(tab(page.container, en.tabSettings).getAttribute('aria-selected'), 'true')
  } finally { await page.close() }
})

await test('a failed read is stated instead of a status', async () => {
  const page = await mount({ console: async () => { throw new Error('remote gone') }, usage: async () => ok(usage), resetUsage: async () => ok({}), saveComputerUse: async () => ok({}) })
  try {
    assert.match(page.container.textContent, /remote gone/)
    assert.match(page.container.textContent, new RegExp(en.unavailable.slice(0, 20)))
  } finally { await page.close() }
})

await test('the settings tab saves only the changed key and blocks invalid values', async () => {
  const saves = []
  let current = snapshot()
  const api = { console: async () => ok(current), usage: async () => ok(usage), resetUsage: async () => ok({}),
    saveComputerUse: async settings => { saves.push(settings); current = snapshot({ ...current.computerUse.values, ...settings }, Object.keys(settings)); return ok({ status: 'applied', effectState: 'applied', message: 'restarted' }) } }
  const page = await mount(api)
  try {
    await click(tab(page.container, en.tabSettings))
    const save = () => [...page.container.querySelectorAll('button')].find(button => button.textContent === en.save)
    assert.equal(save().disabled, true, 'nothing to save yet')
    assert.match(page.container.textContent, /Prefer browser use/)
    await click(page.container.querySelector('#ops-cu-browserFirst'))
    assert.equal(save().disabled, false)
    const opacity = page.container.querySelector('#ops-cu-progressOverlayOpacity')
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
    await act(async () => { setter.call(opacity, '5'); opacity.dispatchEvent(new Event('input', { bubbles: true })) })
    assert.equal(opacity.getAttribute('aria-invalid'), 'true')
    await act(async () => { page.container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    assert.equal(saves.length, 0)
    assert.match(page.container.textContent, new RegExp(en.invalid))
    await act(async () => { setter.call(opacity, '60'); opacity.dispatchEvent(new Event('input', { bubbles: true })) })
    await click(save())
    await act(async () => {})
    assert.deepEqual(saves, [{ browserFirst: false }])
    assert.match(page.container.textContent, /restarted/)
    assert.match(page.container.textContent, new RegExp(en.settingsOverride))
  } finally { await page.close() }
})

await test('the usage tab lists tools and resets only after confirmation', async () => {
  let resets = 0, windows = []
  const api = { console: async () => ok(snapshot()), usage: async days => { windows.push(days); return ok(usage) },
    resetUsage: async () => { resets++; return ok({ status: 'applied', effectState: 'applied', message: 'cleared' }) }, saveComputerUse: async () => ok({}) }
  const page = await mount(api)
  try {
    await click(tab(page.container, en.tabUsage))
    await act(async () => {})
    assert.match(page.container.textContent, /1\.2k/)
    assert.ok(page.container.querySelector('table code').textContent === 'ops_read')
    assert.match(page.container.textContent, /1\.5 s/)
    await click([...page.container.querySelectorAll('button')].find(button => button.textContent === en.days30))
    assert.deepEqual(windows, [7, 30])
    await click([...page.container.querySelectorAll('button')].find(button => button.textContent === en.reset))
    assert.equal(resets, 0, 'the first click only asks')
    await click([...page.container.querySelectorAll('button')].find(button => button.textContent === en.confirm))
    assert.equal(resets, 1)
  } finally { await page.close() }
})

await report('console ui')
