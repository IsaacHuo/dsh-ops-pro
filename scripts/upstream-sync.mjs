#!/usr/bin/env node
/**
 * Report what upstream (T-Auto/dsh-ops) has that this fork has not absorbed yet.
 *
 *   node scripts/upstream-sync.mjs [--no-fetch] [--prs] [--branch pro/next] [--remote upstream] [--json]
 *
 * Read-only apart from `git fetch <remote>`: it never cherry-picks or merges. --prs also
 * lists open upstream pull requests through the GitHub CLI (`gh`).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { absorbedFromLog, classifyCommits, classifyPulls, equivalentFromCherry } from './lib/upstream-sync.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback }
const branch = option('--branch', 'pro/next'), remote = option('--remote', 'upstream'), upstreamRepo = option('--repo', 'T-Auto/dsh-ops')
// GitHub's GraphQL node budget (500,000) caps PRs x commits x authors; 45 x 100 x 100 fits.
const PULL_LIMIT = 45
const git = (...argv) => execFileSync('git', argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

if (!args.includes('--no-fetch')) git('fetch', '--quiet', remote)
const target = `${remote}/main`
const absorbed = absorbedFromLog(git('log', branch, '--format=%B'))
const commits = git('log', '--no-merges', '--format=%H%x09%s', `${branch}..${target}`).split('\n').filter(Boolean)
  .map(line => { const [sha, ...rest] = line.split('\t'); return { sha, subject: rest.join('\t') } })
const report = { branch, upstream: target, commits: classifyCommits(commits, absorbed, equivalentFromCherry(git('cherry', branch, target))) }
if (args.includes('--prs')) {
  const pulls = JSON.parse(execFileSync('gh', ['pr', 'list', '-R', upstreamRepo, '--state', 'open', '--limit', String(PULL_LIMIT), '--json', 'number,title,commits'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
  if (pulls.length >= PULL_LIMIT) console.error(`warning: only the ${PULL_LIMIT} most recent open PRs were listed`)
  const subjects = new Set(git('log', branch, '--format=%s').split('\n').map(s => s.trim()).filter(Boolean))
  const decisions = JSON.parse(fs.readFileSync(new URL('../.github/upstream-decisions.json', import.meta.url), 'utf8'))
  report.pulls = classifyPulls(pulls, absorbed, subjects, decisions)
}
if (args.includes('--json')) {
  console.log(JSON.stringify(report, null, 2))
} else {
  const { commits: c } = report
  console.log(`${target} vs ${branch}: ${c.pending.length} pending, ${c.absorbed.length} absorbed`)
  for (const commit of c.pending) console.log(`  pending ${commit.sha.slice(0, 10)} ${commit.subject}`)
  if (report.pulls) {
    const p = report.pulls
    console.log(`open upstream PRs: ${p.pending.length} pending, ${p.partial.length} partial, ${p.absorbed.length} absorbed, ${p.reworked.length} reworked, ${p.declined.length} declined`)
    for (const kind of ['pending', 'partial']) for (const pull of p[kind]) console.log(`  ${kind} #${pull.number} ${pull.title}`)
  }
}
