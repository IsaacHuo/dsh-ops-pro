/**
 * Every place the release version is written, read and rewritten from one list.
 *
 * 1.0.0 shipped a `chore(release)` commit that edited these by hand and never restaged `runtime/`, so
 * the packaged worker's receipt kept the old version and every native tool degraded. `readVersionSites`
 * feeds `validate-manifest` (drift is a failure) and `scripts/release-prepare.mjs` (one command writes
 * them all, then restages).
 */
import fs from 'node:fs'
import path from 'node:path'

const CORE_CRATE = 'dsh-ops-core'

/** `[package]` version line of a Cargo manifest. */
const CARGO_TOML = /^(\[package\][^[]*?\nversion = ")([^"]+)(")/m
/** The `[[package]]` entry of the core crate inside Cargo.lock. */
const CARGO_LOCK = new RegExp(`(name = "${CORE_CRATE}"\\nversion = ")([^"]+)(")`)

/** Every site, with how to read and write its version. Paths are package-relative. */
export const VERSION_SITES = Object.freeze([
  { file: 'package.json', read: text => JSON.parse(text).version, write: (text, v) => jsonField(text, v, json => { json.version = v }) },
  { file: 'package-lock.json', read: text => JSON.parse(text).version, write: (text, v) => jsonField(text, v, json => { json.version = v; if (json.packages?.['']) json.packages[''].version = v }) },
  { file: 'package-lock.json#packages[""]', source: 'package-lock.json', read: text => JSON.parse(text).packages?.['']?.version },
  { file: 'dsh-plugin.json', read: text => JSON.parse(text).version, write: (text, v) => jsonField(text, v, json => { json.version = v }) },
  { file: 'native/Cargo.toml', read: text => text.replace(/\r\n/g, '\n').match(CARGO_TOML)?.[2], write: (text, v) => regexField(text, CARGO_TOML, v) },
  { file: 'native/Cargo.lock', read: text => text.replace(/\r\n/g, '\n').match(CARGO_LOCK)?.[2], write: (text, v) => regexField(text, CARGO_LOCK, v) },
])

function jsonField(text, _version, mutate) {
  const json = JSON.parse(text)
  mutate(json)
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  return `${JSON.stringify(json, null, 2)}\n`.replace(/\n/g, eol)
}

function regexField(text, pattern, version) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const normal = text.replace(/\r\n/g, '\n')
  if (!pattern.test(normal)) throw new Error(`version field not found for ${pattern}`)
  return normal.replace(pattern, (_m, head, _old, tail) => `${head}${version}${tail}`).replace(/\n/g, eol)
}

/**
 * Read every declared version plus every staged runtime receipt.
 * @param {string} root package root
 * @returns {{ sites: {file: string, version: string|undefined}[], receipts: {file: string, version: unknown}[] }}
 */
export function readVersionSites(root) {
  const sites = VERSION_SITES.map(site => {
    const file = path.join(root, site.source ?? site.file)
    // A published package carries no lockfile or Cargo sources; an absent site is not drift.
    return fs.existsSync(file) ? { file: site.file, version: site.read(fs.readFileSync(file, 'utf8')) } : undefined
  }).filter(Boolean)
  const receipts = []
  const runtime = path.join(root, 'runtime')
  if (fs.existsSync(runtime)) {
    for (const entry of fs.readdirSync(runtime, { withFileTypes: true })) {
      const receipt = path.join(runtime, entry.name, 'provenance.json')
      if (entry.isDirectory() && fs.existsSync(receipt)) {
        receipts.push({ file: `runtime/${entry.name}/provenance.json`, version: JSON.parse(fs.readFileSync(receipt, 'utf8')).version })
      }
    }
  }
  return { sites, receipts }
}

/** Sites and receipts whose version differs from package.json, as `file=version` strings. */
export function versionDrift(root) {
  const { sites, receipts } = readVersionSites(root)
  const expected = sites[0].version
  return { expected, drift: [...sites, ...receipts].filter(row => row.version !== expected).map(row => `${row.file}=${row.version}`) }
}

/** Rewrite every writable site to `version`. Returns the files changed. */
export function writeVersionSites(root, version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`not a semver version: ${version}`)
  const changed = []
  for (const site of VERSION_SITES) {
    if (!site.write) continue
    const file = path.join(root, site.file)
    const before = fs.readFileSync(file, 'utf8')
    const after = site.write(before, version)
    if (after !== before) { fs.writeFileSync(file, after); changed.push(site.file) }
  }
  return changed
}
