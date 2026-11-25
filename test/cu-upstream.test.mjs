/**
 * Upstream dsh-computer-use-win contract suites, run against the assembled vendor tree.
 *
 * Locks in: the byte-identical vendored runtime still passes the upstream suites that need no
 * live desktop (policy, protocol framing, observation budgets, activity series, work modes,
 * browser frames). Suites that drive the real UIA backend stay upstream's responsibility.
 *
 * @module dsh-ops/test/cu-upstream
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { assembleComputerUse, readUpstream } from '../scripts/lib/build/computer-use.mjs'
import { PACKAGE_ROOT, assert, report, skipSuite, test, withTempDir } from './lib/harness.mjs'

if (process.platform !== 'win32') skipSuite('cu-upstream', 'the computer-use runtime is Windows-only')

const HELPERS = new Set(['test/mcp-test-client.mjs', 'test/private-temp.mjs'])
const suites = Object.keys(readUpstream(PACKAGE_ROOT).files).filter(file => file.startsWith('test/') && !HELPERS.has(file))

await withTempDir('cu-upstream', async root => {
  assembleComputerUse(PACKAGE_ROOT, { output: root, includeTests: true })
  for (const suite of suites) {
    await test(`upstream ${path.basename(suite, '.mjs')}`, () => {
      const result = spawnSync(process.execPath, [suite], { cwd: root, encoding: 'utf8', timeout: 180_000,
        env: { ...process.env, NODE_ENV: 'test' }, windowsHide: true })
      assert.equal(result.status, 0, `${suite} exited ${result.status}\n${(result.stderr || result.stdout).slice(-2000)}`)
    })
  }
  assert.ok(fs.existsSync(path.join(root, 'mcp/server.mjs')))
})

report('cu-upstream')
