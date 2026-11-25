/** Real frozen distribution and its import closure for release/IPC fixtures only. */
import fs from 'node:fs'
import path from 'node:path'
import { PACKAGE_ROOT } from './harness.mjs'
import { NIUBASH_PACKAGE_PATH, NIUBASH_PIN, stageNiubashArchive, verifyNiubashTree } from '../../lib/cli/niubash-payload.js'

export const NIUBASH_MODULES = ['fs/rename-retry.js', 'niubash/runtime.js', 'niubash/faces.js', 'niubash/prepared-cache.js',
  'niubash/seal.js', 'cli/niubash-payload.js', 'cli/niubash-payload-manifest.json']

export function copyFixtureModules(root, files = NIUBASH_MODULES) {
  for (const file of files) {
    const target = path.join(root, 'lib', file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(PACKAGE_ROOT, 'lib', file), target)
  }
}

/** A tree with the pinned layout and sizes but sparse zero bytes: what metadata-only checks accept. */
export function syntheticNiubashTree(target) {
  for (const name of NIUBASH_PIN.directories) fs.mkdirSync(path.join(target, name), { recursive: true })
  for (const [name, size] of Object.entries(NIUBASH_PIN.sizes)) {
    const file = path.join(target, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '')
    fs.truncateSync(file, size)
  }
  return target
}

export function stageFixtureNiubash(target) {
  if (process.env.DSH_OPS_NIUBASH_ARCHIVE) {
    stageNiubashArchive(process.env.DSH_OPS_NIUBASH_ARCHIVE, target)
  } else {
    const source = path.join(PACKAGE_ROOT, NIUBASH_PACKAGE_PATH)
    verifyNiubashTree(source)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.cpSync(source, target, { recursive: true, dereference: false })
  }
  // A checked-out payload can have been executed in place, which creates runtime
  // directories the frozen archive never had. The released tarball is packed from the
  // archive, so the fixture prunes those directories to match what npm would ship.
  pruneExecutedDirectories(target)
  verifyNiubashTree(target)
  return target
}

function pruneExecutedDirectories(root) {
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const child = path.join(directory, entry.name)
      const relative = path.relative(root, child).split(path.sep).join('/')
      if (NIUBASH_PIN.directories.includes(relative)) walk(child)
      else fs.rmSync(child, { recursive: true, force: true })
    }
  }
  walk(root)
}
