/**
 * Usage counters: aggregation, retention, persistence, a corrupt file, and the
 * composition root counting ops_* calls in every mode without touching results.
 *
 * Cost note: cordis and a temp file only.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { assert, test, report, TEST_HOME } from './lib/harness.mjs'
import { UsageStore, RETENTION_DAYS, localDay } from '../lib/usage/store.js'
import { failed, outputChars, setUsageStore } from '../lib/usage/hook.js'
import { publicToolName } from '../lib/policy.js'

const DAY = 86400000
const file = () => path.join(mkdtempSync(path.join(TEST_HOME, 'usage-')), 'usage.json')
const event = (tool, ok = true, ms = 10, chars = 40, viaCode = false) => ({ tool, ok, ms, outputChars: chars, viaCode })

await test('a window aggregates calls, failures, run_code calls and percentiles', () => {
  let now = Date.parse('2026-11-25T12:00:00')
  const store = new UsageStore(file(), () => now)
  for (let ms = 1; ms <= 100; ms += 1) store.record(event('ops_grep', ms % 10 !== 0, ms, 4, ms % 2 === 0))
  now -= DAY
  store.record(event('ops_bash', true, 5, 400))
  now += DAY
  const summary = store.summary(7)
  assert.equal(summary.calls, 101)
  assert.equal(summary.failed, 10)
  assert.equal(summary.outputChars, 800)
  assert.equal(summary.estimatedTokens, 200)
  assert.equal(summary.daily.length, 7)
  assert.deepEqual(summary.daily.slice(-2).map(entry => entry.calls), [1, 100])
  const grep = summary.tools[0]
  assert.equal(grep.tool, 'ops_grep')
  assert.equal(grep.viaCode, 50)
  assert.equal(grep.p50Ms, 50)
  assert.equal(grep.p95Ms, 95)
  assert.equal(store.summary(1).calls, 100)
})

await test('counters persist, old days are dropped, and reset clears the file', () => {
  let now = Date.parse('2026-11-25T12:00:00')
  const target = file()
  const store = new UsageStore(target, () => now)
  store.record(event('ops_glob'))
  now -= (RETENTION_DAYS + 3) * DAY
  store.record(event('ops_old'))
  now += (RETENTION_DAYS + 3) * DAY
  store.flush()
  const saved = JSON.parse(readFileSync(target, 'utf8'))
  assert.deepEqual(Object.keys(saved.days), [localDay(now)])
  const reread = new UsageStore(target, () => now)
  assert.equal(reread.summary(30).calls, 1)
  reread.reset()
  assert.equal(new UsageStore(target, () => now).summary(30).calls, 0)
})

await test('a corrupt file starts a fresh count and says so', () => {
  const target = file()
  writeFileSync(target, '{not json')
  const store = new UsageStore(target)
  store.record(event('ops_stat'))
  assert.match(store.summary().storeError, /usage file ignored/)
  assert.equal(store.summary().calls, 1)
  store.flush()
  assert.equal(store.summary().storeError, undefined)
})

await test('returned failure values count as failures; text length is the output size', () => {
  assert.equal(failed({ isError: false, value: { status: 'completed' } }), false)
  assert.equal(failed({ isError: false, value: { status: 'rejected' } }), true)
  assert.equal(failed({ isError: true, error: {} }), true)
  assert.equal(outputChars({ content: [{ type: 'text', text: 'abc' }, { type: 'image' }, { type: 'text', text: 'de' }] }), 5)
})

await test('the composition root counts ops_* calls in every mode and leaves results unchanged', async () => {
  const store = new UsageStore(file())
  const previous = setUsageStore(store)
  try {
    const { apply } = await import('../lib/index.js')
    const ctx = new Context()
    const fiber = ctx.plugin({ name: 'row', apply: inner => apply(inner, {}) })
    await fiber
    const result = { isError: false, value: { status: 'completed' }, content: [{ type: 'text', text: 'hello' }] }
    const ops = await ctx.waterfall('tools/execute', { name: publicToolName('grep'), parent: {} }, () => Promise.resolve(result))
    assert.equal(ops, result)
    await ctx.waterfall('tools/execute', { name: 'read' }, () => Promise.resolve(result))
    const summary = store.summary(1)
    assert.equal(summary.calls, 1, 'only ops_* calls are counted, once each')
    assert.equal(summary.tools[0].tool, publicToolName('grep'))
    assert.equal(summary.tools[0].viaCode, 1)
    assert.equal(summary.outputChars, 5)
    await fiber.dispose()
  } finally { setUsageStore(previous) }
})

await report('usage stats')
