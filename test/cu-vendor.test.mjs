/**
 * Vendored computer-use runtime (vendor/computer-use, scripts/lib/build/computer-use.mjs).
 *
 * Locks in: every vendored file reassembles to the SHA-256 pinned in upstream.json, so the
 * split parts are byte-identical moves of upstream; a hand edit to a part fails the build and
 * names the file; the build ships only the runtime subset plus an ES-module package manifest
 * carrying the upstream version; every part stays under the 1000-line gate.
 *
 * @module dsh-ops/test/cu-vendor
 */
import fs from 'node:fs'
import path from 'node:path'
import { assembleComputerUse, readUpstream, upstreamBytes, VENDOR_DIR } from '../scripts/lib/build/computer-use.mjs'
import { PACKAGE_ROOT, assert, report, test, withTempDir } from './lib/harness.mjs'

const upstream = readUpstream(PACKAGE_ROOT)

/** Copy the vendored tree into root so it can be tampered with. */
function copyVendor(root) {
  fs.cpSync(path.join(PACKAGE_ROOT, VENDOR_DIR), path.join(root, VENDOR_DIR), { recursive: true })
}

await test('every vendored file and split part reassembles to the pinned upstream digest', () => {
  assert.match(upstream.commit, /^[0-9a-f]{40}$/)
  assert.equal(upstream.repository, 'https://github.com/Yu-tao-Li/dsh-computer-use-win')
  const split = Object.entries(upstream.files).filter(([, entry]) => entry.parts)
  assert.deepEqual(split.map(([file]) => file).sort(),
    ['mcp/browser.mjs', 'mcp/server.mjs', 'scripts/windows-takeover.cs', 'scripts/windows-uia.ps1'])
  for (const [file, entry] of Object.entries(upstream.files)) {
    assert.ok(upstreamBytes(PACKAGE_ROOT, file, entry).length > 0, file)
    for (const part of entry.parts ?? []) {
      const lines = fs.readFileSync(path.join(PACKAGE_ROOT, VENDOR_DIR, part), 'utf8').split('\n').length
      assert.ok(lines <= 1000, `${part} has ${lines} lines`)
    }
  }
})

await test('a hand-edited part fails assembly and names the file', async () => {
  await withTempDir('cu-vendor-tamper', root => {
    copyVendor(root)
    const part = path.join(root, VENDOR_DIR, 'mcp/server.part2.mjs')
    fs.appendFileSync(part, '// local change\n')
    assert.throws(() => assembleComputerUse(root, { output: path.join(root, 'out') }),
      /vendor\/computer-use\/mcp\/server\.mjs differs from upstream .*never edited by hand/)
  })
})

await test('assembly ships the runtime subset with a module manifest, not tests or licenses', async () => {
  await withTempDir('cu-vendor-assemble', root => {
    copyVendor(root)
    const output = path.join(root, 'out')
    const result = assembleComputerUse(root, { output })
    assert.equal(result.commit, upstream.commit)
    const pkg = JSON.parse(fs.readFileSync(path.join(output, 'package.json'), 'utf8'))
    assert.deepEqual([pkg.type, pkg.version], ['module', upstream.version])
    assert.ok(fs.existsSync(path.join(output, 'mcp/server.mjs')))
    assert.ok(fs.existsSync(path.join(output, 'scripts/native/manifest.json')))
    assert.ok(!fs.existsSync(path.join(output, 'test')))
    assert.ok(!fs.existsSync(path.join(output, 'LICENSE')))
    const server = fs.readFileSync(path.join(output, 'mcp/server.mjs'))
    assert.equal(server.length, upstreamBytes(root, 'mcp/server.mjs', upstream.files['mcp/server.mjs']).length)
    assert.ok(!fs.existsSync(path.join(output, 'mcp/server.part1.mjs')), 'parts are never shipped')
  })
})

await test('the license texts of both copyright holders ship', () => {
  const license = fs.readFileSync(path.join(PACKAGE_ROOT, 'licenses/computer-use/LICENSE'), 'utf8')
  assert.match(license, /Copyright \(c\) 2026 Yu-tao-Li/)
  assert.match(license, /Copyright \(c\) 2026 cgissing/)
})

report('cu-vendor')
