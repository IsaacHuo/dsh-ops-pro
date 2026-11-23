/** Inventory of host API touch points in the plugin source, the ratchet that gates it, and the host-name contract. */
import fs from 'node:fs'
import path from 'node:path'

/** Patterns that reach the host: event subscriptions, service lookups, injections, cordis internals. */
const PATTERNS = [
  { kind: 'event', re: /\.(?:on|serial|parallel|bail|waterfall)\(\s*'([^']+)'/g },
  { kind: 'service', re: /\.(?:get|provide)\(\s*'([^']+)'/g },
  { kind: 'inject', re: /\.inject\(\s*\[([^\]]*)\]/g },
  { kind: 'cordis-internal', re: /Symbol\.for\(\s*'(cordis[^']*)'/g },
]

/** Scan one source text; returns one record per touch point with its 1-based line. */
export function scanHostSurface(text) {
  const found = []
  const lineAt = index => text.slice(0, index).split('\n').length
  for (const { kind, re } of PATTERNS) {
    for (const match of text.matchAll(re)) {
      const names = kind === 'inject' ? [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1]) : [match[1]]
      for (const name of names) found.push({ kind, name, line: lineAt(match.index) })
    }
  }
  return found.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name))
}

/** Walk a source tree (.ts/.tsx/.cts/.mts) and scan every file. */
export function inventory(root) {
  const files = []
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (/\.(?:c|m)?tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(file)
    }
  }
  walk(root)
  return files.sort().flatMap(file => scanHostSurface(fs.readFileSync(file, 'utf8'))
    .map(hit => ({ file: path.relative(root, file).split(path.sep).join('/'), ...hit })))
}

/** Group hits as kind:name -> { count, areas } where an area is the first path segment. */
export function summarize(hits) {
  const rows = new Map()
  for (const hit of hits) {
    const key = hit.kind + ':' + hit.name
    const row = rows.get(key) ?? { kind: hit.kind, name: hit.name, count: 0, areas: new Set() }
    row.count += 1
    row.areas.add(hit.file.includes('/') ? hit.file.slice(0, hit.file.indexOf('/')) : '(root)')
    rows.set(key, row)
  }
  return [...rows.values()].map(row => ({ ...row, areas: [...row.areas].sort() }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
}

/** Files under this prefix (relative to src/) are the host adapter: the one place free to touch the host. */
export const HOST_BOUNDARY = 'adapter/dsh/'

/** Count hits outside the boundary as { file: { 'kind:name': count } }, with sorted keys. */
export function surfaceCounts(hits, boundary = HOST_BOUNDARY) {
  const counts = {}
  for (const hit of hits) {
    if (hit.file.startsWith(boundary)) continue
    const row = counts[hit.file] ??= {}
    const key = hit.kind + ':' + hit.name
    row[key] = (row[key] ?? 0) + 1
  }
  return Object.fromEntries(Object.keys(counts).sort().map(file =>
    [file, Object.fromEntries(Object.keys(counts[file]).sort().map(key => [key, counts[file][key]]))]))
}

/**
 * Compare current counts with the recorded baseline.
 * grown: a file gained a touch point (fails the gate). shrunk: a file now uses fewer than recorded, so
 * the baseline must be lowered in the same change (also fails, so the ratchet never loosens silently).
 */
export function compareSurface(current, baseline) {
  const grown = []
  const shrunk = []
  const files = new Set([...Object.keys(current), ...Object.keys(baseline)])
  for (const file of [...files].sort()) {
    const now = current[file] ?? {}
    const was = baseline[file] ?? {}
    for (const key of [...new Set([...Object.keys(now), ...Object.keys(was)])].sort()) {
      const c = now[key] ?? 0
      const b = was[key] ?? 0
      if (c > b) grown.push({ file, key, baseline: b, current: c })
      else if (c < b) shrunk.push({ file, key, baseline: b, current: c })
    }
  }
  return { grown, shrunk }
}

/** Names src/ uses that no host package has to define, each with the reason. */
export const NON_HOST_NAMES = Object.freeze({
  'event:dsh-ops/modes': 'emitted and observed by this plugin (src/presets/registry.ts)',
  'service:opsSettings': 'provided by this plugin (src/settings/runtime-host.ts)',
  'service:remote.opsSettings': 'the browser remote of the service this plugin provides',
  'service:remote.dsh-ops': 'the older name of that remote, still looked up by src/client/index.tsx',
  'service:job_output': 'a tool name looked up in the tools registry, not a service',
  'service:shellEnv': 'optional: hosts without it contribute no extra environment',
  'service:tuiPanels': 'provided only by the TUI app, which this checkout does not install',
})

/** Concatenated JavaScript of every installed @deepseek-ai package (without nested node_modules). */
export function hostPackageText(nodeModules) {
  const scope = path.join(nodeModules, '@deepseek-ai')
  const parts = []
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) { if (!['node_modules', 'src', 'test'].includes(entry.name)) walk(file) }
      else if (/\.(?:m|c)?js$/.test(entry.name)) parts.push(fs.readFileSync(file, 'utf8'))
    }
  }
  for (const entry of fs.readdirSync(scope)) walk(fs.realpathSync(path.join(scope, entry)))
  return parts.join('\n')
}

/**
 * Contract between src/ and the installed host.
 * missing: event/service/inject names src/ uses that no host package mentions as a string literal and
 * that NON_HOST_NAMES does not explain (a host rename lands here). unused: NON_HOST_NAMES entries src/
 * no longer uses. Cordis-internal symbols are checked by test/host-root.test.mjs instead.
 */
export function hostContract(rows, hostText, explained = NON_HOST_NAMES) {
  const used = new Set()
  const missing = []
  for (const row of rows) {
    if (row.kind === 'cordis-internal') continue
    const key = (row.kind === 'inject' ? 'service' : row.kind) + ':' + row.name
    if (used.has(key)) continue
    used.add(key)
    if (key in explained) continue
    const quoted = ["'", '"', '\u0060'].some(q => hostText.includes(q + row.name + q))
    if (!quoted) missing.push(key)
  }
  return { missing: missing.sort(), unused: Object.keys(explained).filter(key => !used.has(key)).sort() }
}
