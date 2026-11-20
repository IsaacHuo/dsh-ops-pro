/**
 * Pure classification for the upstream sync report: which upstream commits and
 * open pull requests this fork has already absorbed. Absorption is recorded by
 * `git cherry-pick -x`, whose trailer names the upstream commit; a patch-id
 * match (`git cherry`) covers a pick made without -x.
 */

const TRAILER = /\(cherry picked from commit ([0-9a-f]{7,40})\)/g

/**
 * Every upstream commit named by a cherry-pick trailer in a log body.
 * @param {string} log - `git log --format=%B` output.
 * @returns {Set<string>} full or abbreviated SHAs, lower-case.
 */
export function absorbedFromLog(log) {
  const found = new Set()
  for (const match of log.matchAll(TRAILER)) found.add(match[1].toLowerCase())
  return found
}

/**
 * Whether one SHA is in the absorbed set, accepting abbreviated trailers.
 * @param {string} sha - the full upstream SHA.
 * @param {Set<string>} absorbed - from {@link absorbedFromLog}.
 * @returns {boolean}
 */
export function isAbsorbed(sha, absorbed) {
  const full = sha.toLowerCase()
  if (absorbed.has(full)) return true
  for (const entry of absorbed) if (entry.length < full.length && full.startsWith(entry)) return true
  return false
}

/**
 * Split upstream commits into absorbed and pending.
 * @param {{sha: string, subject: string}[]} commits - upstream commits not reachable from the fork.
 * @param {Set<string>} absorbed - trailer SHAs.
 * @param {Set<string>} [equivalent] - SHAs `git cherry` reports as already applied ('-').
 * @returns {{absorbed: object[], pending: object[]}}
 */
export function classifyCommits(commits, absorbed, equivalent = new Set()) {
  const result = { absorbed: [], pending: [] }
  for (const commit of commits) {
    const done = isAbsorbed(commit.sha, absorbed) || equivalent.has(commit.sha.toLowerCase())
    result[done ? 'absorbed' : 'pending'].push(commit)
  }
  return result
}

/**
 * Whether one upstream commit landed in the fork: by trailer SHA, or by subject when it was
 * picked without -x. The GitHub headline may be cut with an ellipsis; then its prefix is compared.
 * @param {{oid: string, messageHeadline?: string}} commit - one pull request commit.
 * @param {Set<string>} absorbed - trailer SHAs.
 * @param {Set<string>} subjects - every commit subject on the fork branch.
 * @returns {boolean}
 */
export function commitLanded(commit, absorbed, subjects) {
  if (isAbsorbed(commit.oid, absorbed)) return true
  const headline = (commit.messageHeadline ?? '').trim()
  if (headline === '') return false
  if (!headline.endsWith('…')) return subjects.has(headline)
  const prefix = headline.slice(0, -1)
  for (const subject of subjects) if (subject.startsWith(prefix)) return true
  return false
}

/**
 * Classify open upstream pull requests against the fork.
 * `declined` and `reworked` come from the maintained decision record and win over commit matching.
 * @param {{number: number, title: string, commits?: {oid: string, messageHeadline?: string}[]}[]} pulls - open pull requests.
 * @param {Set<string>} absorbed - trailer SHAs.
 * @param {Set<string>} subjects - fork commit subjects.
 * @param {{declined?: Record<string, string>, reworked?: Record<string, string>}} [decisions] - recorded outcomes by PR number.
 * @returns {{absorbed: object[], partial: object[], reworked: object[], declined: object[], pending: object[]}}
 */
export function classifyPulls(pulls, absorbed, subjects = new Set(), decisions = {}) {
  const result = { absorbed: [], partial: [], reworked: [], declined: [], pending: [] }
  for (const pull of pulls) {
    const key = String(pull.number)
    if (decisions.declined?.[key] !== undefined) { result.declined.push({ ...pull, note: decisions.declined[key] }); continue }
    if (decisions.reworked?.[key] !== undefined) { result.reworked.push({ ...pull, note: decisions.reworked[key] }); continue }
    const commits = pull.commits ?? []
    const landed = commits.filter(commit => commitLanded(commit, absorbed, subjects)).length
    result[commits.length > 0 && landed === commits.length ? 'absorbed' : landed > 0 ? 'partial' : 'pending'].push(pull)
  }
  return result
}

/**
 * `git cherry <fork> <upstream>` lines marked '-' (an equivalent patch is already in the fork).
 * @param {string} output - the command output.
 * @returns {Set<string>}
 */
export function equivalentFromCherry(output) {
  const found = new Set()
  for (const line of output.split(/\r?\n/)) {
    const match = /^- ([0-9a-f]{40})$/.exec(line.trim())
    if (match) found.add(match[1])
  }
  return found
}
