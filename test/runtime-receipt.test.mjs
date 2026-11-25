/**
 * Field-level provenance verdicts for the packaged native worker.
 *
 * What this suite locks in:
 *
 * - A receipt whose only disagreement is the version (a `link:` checkout after a version bump that
 *   did not restage) still resolves, with a warning naming both versions and the restage command.
 *   This is the 1.0.0 regression: a byte-identical worker disabled every native tool.
 * - Any byte or identity disagreement (sha256, target, executable) is still refused, and the error
 *   names the field and `npm run build:ptc`.
 * - The release gate (`bin/native-runtime.mjs check`) stays strict about the version.
 * - `receiptMismatches` reports each disagreeing field.
 *
 * Synthetic worker bytes only, so it runs on every host without a built worker.
 *
 * @module dsh-ops/test/runtime-receipt
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { PLATFORMS, receiptMismatches, resolveWorker, workerName } from '../lib/execution/runtime.js'
import { PACKAGE_ROOT, assert, report, test, withTempDir } from './lib/harness.mjs'

const HOST = `${process.platform}-${process.arch}`
const VERSION = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version

/** Stage a fake package with one runtime target; `receipt` overrides receipt fields. */
function stage(root, receipt = {}) {
  fs.mkdirSync(path.join(root, 'runtime', HOST), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: VERSION }))
  const worker = path.join(root, 'runtime', HOST, workerName(process.platform))
  const bytes = Buffer.from('synthetic worker bytes')
  fs.writeFileSync(worker, bytes)
  if (process.platform !== 'win32') fs.chmodSync(worker, 0o755)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  fs.writeFileSync(path.join(root, 'runtime', HOST, 'provenance.json'), JSON.stringify({
    version: VERSION, target: HOST, executable: workerName(process.platform), sha256, ...receipt,
  }))
  return worker
}

/** Run fn while capturing console.warn lines. */
function captureWarnings(fn) {
  const lines = []
  const original = console.warn
  console.warn = (...args) => { lines.push(args.join(' ')) }
  try { return { value: fn(), lines } } finally { console.warn = original }
}

await test('receiptMismatches names each disagreeing field', async () => {
  const expected = { version: '1.0.0', target: 'win32-x64', executable: 'w.exe', sha256: 'a'.repeat(64) }
  assert.deepEqual(receiptMismatches({ ...expected }, expected), [])
  assert.deepEqual(receiptMismatches({ ...expected, version: '0.5.5' }, expected), ['version 0.5.5≠1.0.0'])
  const all = receiptMismatches({ version: '0', target: 'x', executable: 'y', sha256: 'b'.repeat(64) }, expected)
  assert.equal(all.length, 4)
  assert.ok(all.some(row => row.startsWith('sha256 ')))
})

await test('a version-only stale receipt resolves with a warning', async () => {
  if (!PLATFORMS.includes(HOST)) return
  await withTempDir('receipt-stale-version', async root => {
    const worker = stage(root, { version: '0.0.1-stale' })
    const { value, lines } = captureWarnings(() => resolveWorker({}, { packageRoot: root, env: {} }))
    assert.equal(value, worker)
    assert.ok(lines.some(line => line.includes(`version 0.0.1-stale≠${VERSION}`) && line.includes('npm run build:ptc')), lines.join('\n'))
  })
})

await test('a byte mismatch is refused with the field and the repair command', async () => {
  if (!PLATFORMS.includes(HOST)) return
  await withTempDir('receipt-bad-sha', async root => {
    stage(root, { sha256: 'f'.repeat(64), version: '0.0.1-stale' })
    assert.throws(() => resolveWorker({}, { packageRoot: root, env: {} }),
      error => /provenance mismatch/.test(error.message) && /sha256 /.test(error.message)
        && /version 0\.0\.1-stale/.test(error.message) && /npm run build:ptc/.test(error.message))
  })
})

await test('the release gate stays strict about a version-only drift', async () => {
  if (!PLATFORMS.includes(HOST)) return
  await withTempDir('receipt-gate-strict', async root => {
    stage(root, { version: '0.0.1-stale' })
    const result = spawnSync(process.execPath, [path.join(PACKAGE_ROOT, 'bin', 'native-runtime.mjs'), 'check', '--staged', '--root', root], { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}${result.stderr}`, /Runtime provenance mismatch: [^\n]*version 0\.0\.1-stale/)
  })
})

report('runtime-receipt')
