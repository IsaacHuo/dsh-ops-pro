#!/usr/bin/env node
/**
 * Ratchet on host touch points outside src/adapter/dsh/.
 *
 * Every event subscription, service lookup, injection and cordis-internal symbol outside the host
 * adapter is recorded per file in scripts/host-surface-baseline.json. A file that gains one fails;
 * a file that drops one fails until the baseline is lowered, so the count only ever goes down.
 *
 * Usage: node scripts/check-host-surface.mjs [--update]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOST_BOUNDARY, compareSurface, inventory, surfaceCounts } from './lib/host-surface.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const baselineFile = path.join(here, 'host-surface-baseline.json')
const current = surfaceCounts(inventory(path.join(here, '..', 'src')))
const total = counts => Object.values(counts).reduce((sum, row) => sum + Object.values(row).reduce((a, b) => a + b, 0), 0)

if (process.argv.includes('--update')) {
  fs.writeFileSync(baselineFile, JSON.stringify(current, null, 2) + '\n')
  console.log('check-host-surface: baseline written (' + total(current) + ' touch points outside src/' + HOST_BOUNDARY + ')')
  process.exit(0)
}

const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'))
const { grown, shrunk } = compareSurface(current, baseline)
for (const item of grown) {
  console.error('check-host-surface: src/' + item.file + ' gained ' + item.key + ' (' + item.baseline + ' -> ' + item.current
    + '). Route it through src/' + HOST_BOUNDARY + ', or justify it in the PR and run --update.')
}
for (const item of shrunk) {
  console.error('check-host-surface: src/' + item.file + ' now uses ' + item.key + ' ' + item.current + ' time(s), baseline says '
    + item.baseline + '. Lower the baseline: node scripts/check-host-surface.mjs --update')
}
if (grown.length + shrunk.length > 0) process.exit(1)
console.log('check-host-surface: ' + total(current) + ' touch point(s) outside src/' + HOST_BOUNDARY + ' match the baseline')
