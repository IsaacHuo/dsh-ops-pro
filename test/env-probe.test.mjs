import assert from 'node:assert/strict'
import { envChecks, renderChecks } from '../scripts/lib/env-probe.mjs'
import { test, report } from './lib/harness.mjs'

const io = (over = {}) => ({ platform: 'win32', arch: 'x64', env: {}, exists: () => false, list: () => undefined, run: () => undefined, ...over })
const byId = checks => Object.fromEntries(checks.map(check => [check.id, check]))

await test('POSIX hosts check only the worker and cargo', () => {
  const checks = envChecks(io({ platform: 'linux', exists: file => file === 'runtime/linux-x64/dsh-ops-worker', run: () => 'cargo 1.91.0' }))
  assert.deepEqual(checks.map(check => [check.id, check.ok]), [['worker', true], ['cargo', true]])
})

await test('an emptied bash-ipc directory is attributed to endpoint security, not to a missing build', () => {
  const empty = byId(envChecks(io({ list: dir => dir === 'runtime/win32-x64/bash-ipc' ? [] : undefined })))['bash-ipc']
  assert.equal(empty.ok, false)
  assert.match(empty.detail, /endpoint security/)
  assert.ok(empty.affects.includes('permissions'))
  const absent = byId(envChecks(io()))['bash-ipc']
  assert.match(absent.detail, /build:bash-ipc/)
  const staged = byId(envChecks(io({ list: dir => dir === 'runtime/win32-x64/bash-ipc' ? ['opsipc.dll', 'provenance.json'] : undefined })))['bash-ipc']
  assert.equal(staged.ok, true)
})

await test('a staged Niubash archive is named when the variable is unset', () => {
  const check = byId(envChecks(io({ list: dir => dir === 'dist/downloads' ? ['niubash-v1.5.0-win-x64.tar.gz'] : undefined })))['niubash-archive']
  assert.equal(check.ok, false)
  assert.match(check.detail, /DSH_OPS_NIUBASH_ARCHIVE=dist\/downloads\/niubash-v1\.5\.0-win-x64\.tar\.gz/)
})

await test('a stale DSH_OPS_TEST_BASH path is a miss, and misses render first', () => {
  const checks = envChecks(io({ env: { DSH_OPS_TEST_BASH: 'C:/gone/bash.exe', DSH_OPS_WORKER_BIN: 'w.exe' }, exists: file => file === 'w.exe' }))
  assert.equal(byId(checks)['test-bash'].ok, false)
  assert.equal(byId(checks).worker.detail, 'w.exe', 'an explicit worker selection is honoured')
  const lines = renderChecks(checks).split('\n')
  assert.match(lines[0], /^MISS/)
  assert.match(lines.at(-1), /^ok {4}worker/)
})

report('env-probe')
