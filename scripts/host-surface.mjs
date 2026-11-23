#!/usr/bin/env node
/** Print where src/ touches the host. Usage: node scripts/host-surface.mjs [--json] [--files] */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inventory, summarize } from './lib/host-surface.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
const hits = inventory(root)
const rows = summarize(hits)
if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify(process.argv.includes('--files') ? hits : rows, null, 2) + '\n')
} else {
  for (const row of rows) console.log(String(row.count).padStart(4) + '  ' + (row.kind + ' ' + row.name).padEnd(44) + row.areas.join(' '))
  const areas = new Set(rows.flatMap(row => row.areas))
  console.log(hits.length + ' touch points, ' + rows.length + ' distinct, ' + areas.size + ' areas')
}
