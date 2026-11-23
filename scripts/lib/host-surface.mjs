/** Inventory of host API touch points in the plugin source (R0; R1 turns it into a gate). */
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
