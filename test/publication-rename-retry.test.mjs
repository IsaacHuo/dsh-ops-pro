/** Publication renames back off a transient Windows sharing refusal; cleanup renames do not (#352). */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { stageNiubashArchive, verifyNiubashTree } from '../lib/cli/niubash-payload.js'
import { provisionShell, validatePin } from '../lib/cli/provision-shells.js'
import { assert, report, test, withTempDir } from './lib/harness.mjs'

const sha256Of = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const eperm = () => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })

/** Refuse the first rename whose source is a staging sibling, exactly as a scanner holding the new tree does. */
function refuseFirstStageRename(run) {
  const rename = fs.renameSync
  const refused = []
  fs.renameSync = (source, destination) => {
    if (refused.length === 0 && path.basename(String(source)).includes('.stage-')) { refused.push([source, destination]); throw eperm() }
    return rename(source, destination)
  }
  try { return { value: run(), refused } } finally { fs.renameSync = rename }
}

await test('Niubash archive staging retries a transient refusal of the publication rename', () => withTempDir('stage-rename-retry', root => {
  const archive = process.env.DSH_OPS_NIUBASH_ARCHIVE
  if (!archive) { console.log('  skip Niubash staging retry — requires DSH_OPS_NIUBASH_ARCHIVE'); return }
  const target = path.join(root, 'niu')
  const { refused } = refuseFirstStageRename(() => stageNiubashArchive(archive, target))
  assert.equal(refused.length, 1, 'the staging rename was refused once')
  assert.equal(refused[0][1], target)
  assert.equal(verifyNiubashTree(target), path.join(target, 'niu.exe'))
  assert.deepEqual(fs.readdirSync(root).filter(name => name.includes('.stage-')), [], 'no staging sibling is left behind')
}))

const BSDTAR = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'tar.exe')
await test('shell provisioning retries a transient refusal of the publication rename', () => withTempDir('provision-rename-retry', dir => {
  if (process.platform !== 'win32' || process.arch !== 'x64' || !fs.existsSync(BSDTAR)) { console.log('  skip shell provisioning retry — needs win32-x64 with bsdtar'); return }
  const staged = path.join(dir, 'staged')
  fs.mkdirSync(staged)
  fs.writeFileSync(path.join(staged, 'pwsh.exe'), 'forged pwsh 0.0.1\n')
  const asset = path.join(dir, 'forged-pwsh.zip')
  const zipped = spawnSync(BSDTAR, ['-a', '-cf', asset, '-C', staged, '.'], { encoding: 'utf8' })
  assert.equal(zipped.status, 0, zipped.stderr)
  const pin = validatePin({ name: 'pwsh', label: 'forged', platform: 'win32', arch: 'x64', upstreamRepo: 'https://example.invalid/pwsh',
    releaseTag: 'v0.0.1', version: '0.0.1', assetFile: 'forged-pwsh.zip', url: new URL('file:///' + asset.replace(/\\/g, '/')).href,
    sha256: sha256Of(asset), executableSha256: sha256Of(path.join(staged, 'pwsh.exe')), bytes: fs.statSync(asset).size, license: 'MIT',
    extractor: 'zip', extractTo: 'bin', executableRelativePath: 'bin/pwsh.exe' }, 0)
  const { value, refused } = refuseFirstStageRename(() => provisionShell(pin, { force: true, dryRun: false }))
  assert.equal(value, true, 'the install completes after the transient refusal')
  assert.equal(refused.length, 1, 'the staging rename was refused once')
  const target = refused[0][1]
  assert.equal(sha256Of(path.join(target, 'bin', 'pwsh.exe')), pin.executableSha256)
  assert.deepEqual(fs.readdirSync(path.dirname(target)).filter(name => name.includes('.stage-')), [], 'no staging sibling is left behind')
}))

report('publication-rename-retry')
