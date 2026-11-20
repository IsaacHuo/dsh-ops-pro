import { assert, test, report } from './lib/harness.mjs'
import { absorbedFromLog, classifyCommits, classifyPulls, commitLanded, equivalentFromCherry, isAbsorbed } from '../scripts/lib/upstream-sync.mjs'

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40)

await test('cherry-pick trailers mark upstream commits absorbed, abbreviated or full', () => {
  const absorbed = absorbedFromLog(`fix: x\n\n(cherry picked from commit ${A})\n\nfeat: y\n(cherry picked from commit bbbbbbb)\n`)
  assert.ok(isAbsorbed(A, absorbed))
  assert.ok(isAbsorbed(B, absorbed), 'an abbreviated trailer still names the commit')
  assert.equal(isAbsorbed(C, absorbed), false)
})

await test('commits split into absorbed and pending, counting patch-equivalent picks', () => {
  const commits = [{ sha: A, subject: 'one' }, { sha: B, subject: 'two' }, { sha: C, subject: 'three' }]
  const result = classifyCommits(commits, new Set([A]), equivalentFromCherry(`+ ${C}\n- ${B}\n`))
  assert.deepEqual(result.absorbed.map(c => c.subject), ['one', 'two'])
  assert.deepEqual(result.pending.map(c => c.subject), ['three'])
})

await test('a pull request is absorbed, partial or pending by its commits, and recorded decisions win', () => {
  const subjects = new Set(['fix(x): picked without trailer (#9)', 'feat(y): a long subject that GitHub cuts short in the headline'])
  const pulls = [
    { number: 1, title: 'trailer', commits: [{ oid: A }] },
    { number: 2, title: 'subject', commits: [{ oid: C, messageHeadline: 'fix(x): picked without trailer (#9)' }, { oid: B, messageHeadline: 'feat(y): a long subject that GitHub cuts…' }] },
    { number: 3, title: 'half', commits: [{ oid: A }, { oid: C, messageHeadline: 'not here' }] },
    { number: 4, title: 'none', commits: [{ oid: C, messageHeadline: 'not here' }] },
    { number: 5, title: 'big', commits: [{ oid: A }] },
    { number: 6, title: 'redone', commits: [{ oid: C, messageHeadline: 'not here' }] },
  ]
  const result = classifyPulls(pulls, new Set([A.slice(0, 12)]), subjects, { declined: { 5: 'too large' }, reworked: { 6: 'abc123' } })
  assert.deepEqual(result.absorbed.map(p => p.number), [1, 2])
  assert.deepEqual(result.partial.map(p => p.number), [3])
  assert.deepEqual(result.pending.map(p => p.number), [4])
  assert.deepEqual(result.declined.map(p => [p.number, p.note]), [[5, 'too large']])
  assert.deepEqual(result.reworked.map(p => p.number), [6])
  assert.equal(commitLanded({ oid: C, messageHeadline: '' }, new Set(), subjects), false, 'an empty headline never matches')
})

report('upstream-sync')
