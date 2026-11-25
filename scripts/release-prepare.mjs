#!/usr/bin/env node
/**
 * `npm run release:prepare -- <version>`: the one supported way to bump the release version.
 *
 * Writes every version site (`scripts/lib/version-sync.mjs`), rebuilds and restages the native worker
 * for this host so its receipt carries the new version, then checks the staged runtime. Pass
 * `--no-build` to only rewrite the sites (CI restages on its own); the receipt check then reports the
 * drift instead of hiding it.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { versionDrift, writeVersionSites } from './lib/version-sync.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { values, positionals } = parseArgs({ options: { 'no-build': { type: 'boolean' } }, allowPositionals: true })
const version = positionals[0]
if (!version) { console.error('usage: npm run release:prepare -- <version> [--no-build]'); process.exit(2) }

const changed = writeVersionSites(root, version)
console.log(`release:prepare: ${changed.length ? `rewrote ${changed.join(', ')}` : 'version sites already match'} → ${version}`)

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const steps = values['no-build'] ? [] : [[npm, ['run', 'build']], [npm, ['run', 'build:ptc']]]
for (const [command, args] of steps) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true })
  if (result.status !== 0) { console.error(`release:prepare: ${command} ${args.join(' ')} failed`); process.exit(result.status ?? 1) }
}

const { drift } = versionDrift(root)
if (drift.length) {
  console.error(`release:prepare: still out of date: ${drift.join(', ')}`)
  process.exit(1)
}
console.log('release:prepare: every version site and staged receipt agrees')
