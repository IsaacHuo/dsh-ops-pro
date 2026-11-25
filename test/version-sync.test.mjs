/**
 * Release-version drift guard (scripts/lib/version-sync.mjs).
 *
 * Locks in: every version site and every staged runtime receipt is compared with package.json; a
 * stale receipt is named as drift (the 1.0.0 degrade); `writeVersionSites` rewrites every writable
 * site, keeps line endings, and leaves no drift except receipts it cannot restage.
 *
 * @module dsh-ops/test/version-sync
 */
import fs from 'node:fs'
import path from 'node:path'
import { readVersionSites, versionDrift, writeVersionSites } from '../scripts/lib/version-sync.mjs'
import { PACKAGE_ROOT, assert, report, test, withTempDir } from './lib/harness.mjs'

/** Copy only the version-bearing files of this checkout into root. */
function fixture(root) {
  for (const file of ['package.json', 'package-lock.json', 'dsh-plugin.json', 'native/Cargo.toml', 'native/Cargo.lock']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.copyFileSync(path.join(PACKAGE_ROOT, file), path.join(root, file))
  }
}
const receipt = (root, version) => {
  fs.mkdirSync(path.join(root, 'runtime', 'win32-x64'), { recursive: true })
  fs.writeFileSync(path.join(root, 'runtime', 'win32-x64', 'provenance.json'), JSON.stringify({ version }))
}

await test('this checkout declares one version everywhere', async () => {
  const { sites } = readVersionSites(PACKAGE_ROOT)
  assert.equal(sites.length, 6)
  for (const site of sites) assert.equal(site.version, sites[0].version, site.file)
})

await test('a stale runtime receipt is reported as drift', async () => {
  await withTempDir('version-sync-stale', async root => {
    fixture(root)
    const { expected } = versionDrift(root)
    receipt(root, '0.0.1-stale')
    assert.deepEqual(versionDrift(root).drift, ['runtime/win32-x64/provenance.json=0.0.1-stale'])
    receipt(root, expected)
    assert.deepEqual(versionDrift(root).drift, [])
  })
})

await test('absent sites are skipped, as in a published package', async () => {
  await withTempDir('version-sync-published', async root => {
    for (const file of ['package.json', 'dsh-plugin.json']) fs.copyFileSync(path.join(PACKAGE_ROOT, file), path.join(root, file))
    assert.deepEqual(readVersionSites(root).sites.map(site => site.file), ['package.json', 'dsh-plugin.json'])
    assert.deepEqual(versionDrift(root).drift, [])
  })
})

await test('writeVersionSites rewrites every site and keeps line endings', async () => {
  await withTempDir('version-sync-write', async root => {
    fixture(root)
    const tomlBefore = fs.readFileSync(path.join(root, 'native/Cargo.toml'), 'utf8')
    const changed = writeVersionSites(root, '9.8.7')
    assert.deepEqual(changed.sort(), ['dsh-plugin.json', 'native/Cargo.lock', 'native/Cargo.toml', 'package-lock.json', 'package.json'])
    const { drift, expected } = versionDrift(root)
    assert.equal(expected, '9.8.7')
    assert.deepEqual(drift, [])
    const tomlAfter = fs.readFileSync(path.join(root, 'native/Cargo.toml'), 'utf8')
    assert.equal(tomlAfter.includes('\r\n'), tomlBefore.includes('\r\n'))
    assert.equal(tomlAfter.replace('9.8.7', expected).length, tomlAfter.length)
    assert.deepEqual(writeVersionSites(root, '9.8.7'), [])
    assert.throws(() => writeVersionSites(root, 'not-a-version'), /semver/)
  })
})

report('version-sync')
