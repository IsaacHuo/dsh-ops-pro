/**
 * Assemble the vendored dsh-computer-use-win runtime into `lib/computer-use/`.
 *
 * `vendor/computer-use/upstream.json` pins the upstream commit and the SHA-256 of every
 * vendored file. Upstream files longer than the repository's 1000-line gate are stored as
 * `<name>.partN.<ext>` line ranges; concatenating them in order gives the upstream bytes
 * exactly. Every assembled file is checked against its pinned digest, so a hand edit to a
 * part, a lost part or a reordered list fails the build instead of shipping changed code.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const VENDOR_DIR = 'vendor/computer-use'
export const OUTPUT_DIR = 'lib/computer-use'
/** Shipped runtime roots; upstream tests and license texts stay out of `lib/`. */
const RUNTIME_PREFIXES = ['mcp/', 'scripts/']

const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex')

/** Read and validate the pin file. */
export function readUpstream(root) {
  const file = path.join(root, VENDOR_DIR, 'upstream.json')
  const upstream = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!/^[0-9a-f]{40}$/.test(upstream.commit ?? '') || typeof upstream.version !== 'string' || !upstream.files) {
    throw new Error(`${VENDOR_DIR}/upstream.json must name a commit, a version and the pinned files`)
  }
  return upstream
}

/** The upstream bytes of one pinned file, reassembled from its parts and digest-checked. */
export function upstreamBytes(root, relative, entry) {
  const read = name => {
    if (name.includes('..') || path.isAbsolute(name)) throw new Error(`Invalid vendored path: ${name}`)
    return fs.readFileSync(path.join(root, VENDOR_DIR, name))
  }
  const bytes = Array.isArray(entry.parts) ? Buffer.concat(entry.parts.map(read)) : read(relative)
  const actual = sha256(bytes)
  if (actual !== entry.sha256) {
    throw new Error(`${VENDOR_DIR}/${relative} differs from upstream (sha256 ${actual.slice(0, 12)}… ≠ ${String(entry.sha256).slice(0, 12)}…); vendored files are never edited by hand`)
  }
  return bytes
}

/**
 * Write the runtime subset to `output` (default `lib/computer-use`). `includeTests` also
 * writes the vendored upstream suites, for the repository test that runs them.
 * @returns {{files: number, bytes: number, version: string, commit: string}}
 */
export function assembleComputerUse(root, { output = path.join(root, OUTPUT_DIR), includeTests = false } = {}) {
  if (!fs.existsSync(path.join(root, VENDOR_DIR, 'upstream.json'))) return { files: 0, bytes: 0, version: '', commit: '' }
  const upstream = readUpstream(root)
  let files = 0, bytes = 0
  for (const [relative, entry] of Object.entries(upstream.files)) {
    const shipped = RUNTIME_PREFIXES.some(prefix => relative.startsWith(prefix))
    if (!shipped && !(includeTests && relative.startsWith('test/'))) continue
    const content = upstreamBytes(root, relative, entry)
    const target = path.join(output, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
    files++; bytes += content.length
  }
  // server.mjs reads its MCP serverInfo version from ../package.json; the manifest also
  // makes the directory an ES module scope independent of the host package.
  const pkg = { name: 'dsh-computer-use-win', version: upstream.version, private: true, type: 'module',
    description: `Vendored from ${upstream.repository} at ${upstream.commit}` }
  fs.writeFileSync(path.join(output, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  return { files, bytes, version: upstream.version, commit: upstream.commit }
}
