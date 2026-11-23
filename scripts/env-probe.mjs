#!/usr/bin/env node
/** Report which local prerequisites the test suites need are missing. Exit 1 when any is. */
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { envChecks, renderChecks } from './lib/env-probe.mjs'

const checks = envChecks({
  platform: process.platform, arch: process.arch, env: process.env,
  exists: file => fs.existsSync(file),
  list: dir => { try { return fs.readdirSync(dir) } catch { return undefined } },
  run: (command, args) => {
    const result = spawnSync(command, args, { encoding: 'utf8', shell: false })
    return result.status === 0 ? result.stdout.trim() : undefined
  },
})
console.log(process.argv.includes('--json') ? JSON.stringify(checks, null, 2) : renderChecks(checks))
process.exitCode = checks.every(check => check.ok) ? 0 : 1
