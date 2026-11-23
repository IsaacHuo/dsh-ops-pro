/**
 * The trace-driven batching notices.
 *
 * A root run_code program is judged by the calls it really dispatched (recorded
 * from nested tools/post-execute events) plus its first line, never by parsing
 * its text. These cases pin the rules: no call means no accusation, a shell call
 * is judged by the command it actually ran, the single-call notice needs two
 * single-call programs in a row, waits are barriers, and the session cap holds.
 */
import { assert, test, report } from './lib/harness.mjs'
import { parsePlan, findingsOf, singleCall, tracedCall, createTraceRecorder, createProgramLatch, noticeText,
  CATEGORY_PRIORITY, PLAN_DIRECTIVE, SESSION_NOTICE_LIMIT } from '../lib/ptc/batching-notices.js'

/** A scope that publishes the loader and keeps the pool loadable. */
const LOADER = { loader: true, resident: [], loadable: ['ops_glob', 'ops_grep', 'ops_read_files', 'ops_inspect_local_file', 'ops_edit_file'] }

/** A trace: the program text and the calls it dispatched ([name, args] or a bare name). */
const trace = (code, ...calls) => ({ code, calls: calls.map(call => typeof call === 'string' ? tracedCall(call, {}) : tracedCall(call[0], call[1])) })
/** One unplanned single call. */
const THIN = trace('const row = await tools.ops_stat({ path: "a" })\nreturn row', 'ops_stat')
/** A planned program with two batched calls. */
const GOOD = trace('// plan: list the sources; read the manifest\nreturn await Promise.all([a(), b()])', 'ops_glob', 'ops_read_files')
/** An unplanned shell listing. */
const BYPASS = trace('return await tools.ops_bash({ description: "list", command: "ls -la" })', ['ops_bash', { command: 'ls -la' }])
const NONE = { plan: false, bypass: false, shape: false }

await test('the plan comment is read from the first physical line only', () => {
  assert.deepEqual(parsePlan('// plan: read the config; read the test'), ['read the config', 'read the test'])
  assert.deepEqual(parsePlan('// plan: 读取配置；运行测试'), ['读取配置', '运行测试'])
  assert.deepEqual(parsePlan('  // plan: one ; two'), ['one', 'two'])
  assert.deepEqual(parsePlan('\ufeff// plan: one'), ['one'])
  assert.deepEqual(parsePlan('\n// plan: late'), [])
  assert.deepEqual(parsePlan('const x = 1\n// plan: late'), [])
  assert.deepEqual(parsePlan('// plan:'), [])
  assert.deepEqual(parsePlan(undefined), [])
  assert.equal(PLAN_DIRECTIVE, '// plan:')
})

await test('a traced call keeps only the command and the wait flag', () => {
  assert.deepEqual(tracedCall('ops_bash', { description: 'x', command: 'npm test' }), { name: 'ops_bash', command: 'npm test', waits: false })
  assert.deepEqual(tracedCall('job_output', { job_id: 'b', wait: true }), { name: 'job_output', waits: true })
  assert.deepEqual(tracedCall('ops_stat', undefined), { name: 'ops_stat', waits: false })
})

await test('the recorder groups calls by root and drains them on take', () => {
  const recorder = createTraceRecorder()
  recorder.record('root-1', tracedCall('ops_stat', {}))
  recorder.record('root-2', tracedCall('ops_glob', {}))
  recorder.record('root-1', tracedCall('ops_grep', {}))
  assert.deepEqual(recorder.take('root-1', 'code').calls.map(call => call.name), ['ops_stat', 'ops_grep'])
  assert.deepEqual(recorder.take('root-1', 'code').calls, [], 'a taken root is drained')
  recorder.clear()
  assert.deepEqual(recorder.take('root-2', 'code'), { code: 'code', calls: [] }, 'clear drops every root')
})

await test('a program that dispatched nothing earns no category', () => {
  for (const code of ['return 1', 'import fs from "node:fs"\nreturn 1', '// tools.ops_stat({ path: "a" })\nreturn 1']) {
    assert.deepEqual(findingsOf(trace(code), true), NONE, code)
  }
  const latch = createProgramLatch(() => LOADER), agent = {}
  assert.equal(latch.observe(agent, trace('return 1')), undefined)
  assert.equal(latch.stats(agent).total, 0, 'no category was spent')
})

await test('the plan finding reads only the first line of a program that dispatched', () => {
  assert.equal(findingsOf(THIN, false).plan, true)
  assert.equal(findingsOf(GOOD, false).plan, false)
  assert.deepEqual(findingsOf(GOOD, true), NONE, 'a planned batch is compliant')
})

await test('bypass is real module IO or a shell call whose actual command did file work', () => {
  const shell = command => findingsOf(trace('// plan: run\nawait run()', ['ops_bash', { command }]), false).bypass
  assert.equal(shell('npm run build'), false, 'starting a process is not a bypass')
  assert.equal(shell('ls -la'), true)
  assert.equal(shell('cat package.json'), true)
  for (const command of ['git diff | head -20', "git diff | grep TODO | sed -n '1,20p'", 'printf "hello" | grep hello',
    'npm test | tail -20', 'git diff 2>&1 | head -20', 'git diff | Select-String TODO', 'sed --version']) {
    assert.equal(shell(command), false, command)
  }
  for (const command of ['grep TODO src/file.ts', 'cat file | head -20', 'head -n 2 file', 'cat < file', 'git diff > output.txt',
    'Get-Content file | Select-String TODO']) {
    assert.equal(shell(command), true, command)
  }
  // The text no longer accuses: a commented or quoted shell listing is not what ran.
  assert.equal(findingsOf(trace('// ls -la would be a bypass\nawait run()', ['ops_bash', { command: 'npm run build' }]), false).bypass, false)
  const io = code => findingsOf(trace(code, 'ops_stat'), false).bypass
  assert.equal(io('import fs from "node:fs"\nreturn fs'), true)
  assert.equal(io('const cp = require("node:child_process")\nreturn cp'), true)
  assert.equal(io('// never call node:fs directly\nreturn 1'), false, 'naming the module is not importing it')
})

await test('the shape finding needs two single-call programs in a row', () => {
  assert.equal(singleCall(THIN), true)
  assert.equal(findingsOf(THIN, false).shape, false, 'one single call is not yet a pattern')
  assert.equal(findingsOf(THIN, true).shape, true)
  // A dependent pair, a cursor walk and waits are not single calls.
  const dependent = trace('// plan: search; read\nawait x()', 'grep', 'read')
  const walk = trace('// plan: page the log\nawait x()', 'ops_inspect_local_file', 'ops_inspect_local_file', 'ops_inspect_local_file')
  const agentWait = trace('// plan: wait\nawait x()', 'wait_agent')
  const jobWait = trace('// plan: wait\nawait x()', ['job_output', { job_id: 'b', wait: true }])
  for (const shaped of [dependent, walk, agentWait, jobWait]) {
    assert.equal(singleCall(shaped), false)
    assert.deepEqual(findingsOf(shaped, true), NONE)
  }
})

await test('one category speaks once until compliance re-arms it', () => {
  const latch = createProgramLatch(() => LOADER, { sessionLimit: Infinity }), agent = {}
  assert.equal(latch.observe(agent, THIN).category, 'plan', 'the first program earns the plan notice')
  assert.equal(latch.observe(agent, THIN).category, 'shape', 'the second single call earns the shape notice')
  assert.equal(latch.observe(agent, THIN), undefined, 'plan is spent and the shape run restarted')
  assert.equal(latch.observe(agent, GOOD), undefined, 'the compliant program earns nothing')
  assert.equal(latch.isArmed(agent, 'plan'), true, 'compliance re-arms the category')
  assert.equal(latch.observe(agent, THIN).category, 'plan', 'the regression speaks again')
})

await test('waits between single calls never spend the shape latch (#893, #999)', () => {
  const latch = createProgramLatch(() => LOADER, { sessionLimit: Infinity }), agent = {}
  const planned = trace('// plan: stat\nawait x()', 'ops_stat')
  const wait = trace('// plan: wait\nawait x()', 'wait_agent')
  for (const step of [planned, wait, planned, wait, planned]) assert.equal(latch.observe(agent, step), undefined)
})

await test('the session cap holds across turns (#1027)', () => {
  assert.equal(SESSION_NOTICE_LIMIT, 3)
  const latch = createProgramLatch(() => LOADER), agent = {}
  for (const turn of [1, 2, 3]) {
    latch.noteTurn(agent, turn)
    assert.equal(latch.observe(agent, THIN).category, 'plan', 'turn ' + turn)
  }
  latch.noteTurn(agent, 4)
  assert.equal(latch.observe(agent, THIN), undefined, 'the fourth notice is never sent')
  assert.equal(latch.stats(agent).session, 3)
})

await test('priority orders the categories and the others stay armed', () => {
  const latch = createProgramLatch(() => LOADER), agent = {}
  assert.deepEqual([...CATEGORY_PRIORITY], ['bypass', 'plan', 'shape'])
  assert.equal(latch.observe(agent, BYPASS).category, 'bypass', 'a bypass outranks the other two')
  assert.equal(latch.isArmed(agent, 'plan'), true, 'the plan notice was not spent')
  assert.equal(latch.observe(agent, THIN).category, 'plan')
})

await test('a new turn re-arms every category and a repeated turn does not', () => {
  const latch = createProgramLatch(() => LOADER), agent = {}
  latch.noteTurn(agent, 1)
  assert.equal(latch.observe(agent, THIN).category, 'plan')
  latch.noteTurn(agent, 1)
  assert.equal(latch.isArmed(agent, 'plan'), false, 'the same turn is not a new turn')
  latch.noteTurn(agent, 2)
  assert.equal(latch.observe(agent, THIN).category, 'plan', 'the next turn speaks again')
})

await test('state never leaks between agents and forget drops it', () => {
  const latch = createProgramLatch(() => LOADER), first = {}, second = {}
  assert.equal(latch.observe(first, THIN).category, 'plan')
  assert.equal(latch.observe(second, THIN).category, 'plan', 'the second agent is independent')
  latch.forget(first)
  assert.equal(latch.isArmed(first, 'plan'), true, 'a forgotten agent starts clean')
})

await test('the latch counts deliveries per turn and per session for telemetry', () => {
  const latch = createProgramLatch(() => LOADER), agent = {}
  latch.noteTurn(agent, 4)
  assert.deepEqual(latch.stats(agent), { turn: 4, plan: 0, bypass: 0, shape: 0, total: 0, session: 0 })
  latch.observe(agent, THIN)
  latch.observe(agent, THIN)
  assert.deepEqual(latch.stats(agent), { turn: 4, plan: 1, bypass: 0, shape: 1, total: 2, session: 2 })
  latch.noteTurn(agent, 5)
  assert.deepEqual(latch.stats(agent), { turn: 5, plan: 0, bypass: 0, shape: 0, total: 0, session: 2 }, 'the session count survives the turn')
})

await test('the notices name the fix', () => {
  assert.match(noticeText('plan', LOADER), /first line/)
  assert.doesNotMatch(noticeText('plan', LOADER), /Promise\.all/)
  assert.match(noticeText('bypass', LOADER), /ops_glob/)
  assert.match(noticeText('bypass', LOADER), /ops_load_sdk/)
  assert.match(noticeText('shape', LOADER), /single tool call/)
  assert.match(noticeText('shape', LOADER), /Promise\.all/)
})

await test('the bypass notice names only the APIs its scope publishes', () => {
  // With a loader the notice keeps teaching the load step.
  assert.match(noticeText('bypass', LOADER), /ops_load_sdk/)
  // Without one it must not name a call that cannot succeed, and every other line
  // must stay inside the published surface too.
  const direct = noticeText('bypass', { loader: false, resident: ['ops_glob'], loadable: [] })
  assert.equal(direct.includes('ops_load_sdk'), false, 'the unreachable loader is gone')
  assert.match(direct, /ops_glob/, 'the published API is named')
  for (const absent of ['ops_read_files', 'ops_grep', 'ops_edit_file']) {
    assert.equal(direct.includes(absent), false, 'an unpublished API is not named: ' + absent)
  }
  // A scope that publishes nothing points at the official tools only.
  const none = noticeText('bypass', { loader: false, resident: [], loadable: [] })
  assert.match(none, /official tools/)
  assert.equal(/ops_[a-z_]+/.test(none), false, 'no OPS name survives an empty surface')
})

await test('a narrow pool is not told to load an API it cannot reach', () => {
  // The pool holds stat only: naming edit_file would cost the same failed round trip.
  const narrow = noticeText('bypass', { loader: true, resident: [], loadable: ['ops_stat'] })
  for (const absent of ['ops_edit_file', 'ops_read_files', 'ops_glob']) {
    assert.equal(narrow.includes(absent), false, 'an unloadable API is not named: ' + absent)
  }
  assert.match(narrow, /official tools/, 'an empty file-api intersection points at the official tools')
  // The shipped wording survives while the whole list is loadable.
  assert.match(noticeText('bypass', LOADER), /List with `ops_glob`/)
  // A narrow pool must not invite a load with the old catch-all sentence.
  assert.doesNotMatch(narrow, /load only missing names/, 'the load sentence follows the pool too')
})

await test('a resident file API is named even when the pool cannot load it', () => {
  // read_files is resident and callable without loading; the hint must not claim that
  // no file API exists just because the pool holds stat alone.
  const mixed = noticeText('bypass', { loader: true, resident: ['ops_read_files'], loadable: ['ops_stat'] })
  assert.match(mixed, /ops_read_files/, 'the resident file API is named')
  assert.doesNotMatch(mixed, /No OPS file API is available/, 'the fallback does not fire while one is reachable')
})

await test('the file-work line never names the shell it just accused', () => {
  const mixed = noticeText('bypass', { loader: false, resident: ['ops_bash', 'ops_glob'], loadable: [] })
  assert.match(mixed, /ops_glob/, 'the file API is named')
  assert.equal(mixed.includes('ops_bash'), false, 'the bypass vector is never offered as the fix')
})

await test('the latch resolves the surface per agent', () => {
  const first = {}, second = {}
  const latch = createProgramLatch(agent => agent === first
    ? LOADER
    : { loader: false, resident: ['ops_glob'], loadable: [] })
  assert.match(latch.observe(first, BYPASS).text, /ops_load_sdk/, 'the loader scope keeps its lesson')
  assert.equal(latch.observe(second, BYPASS).text.includes('ops_load_sdk'), false, 'the other agent gets its own surface')
})

await test('a scope with no file API does not refer to them', () => {
  // A resident non-file API leaves the hint pointing at the official tools; the next
  // line must not then invite a call to "those APIs".
  const statOnly = noticeText('bypass', { loader: false, resident: ['ops_stat'], loadable: [] })
  assert.match(statOnly, /official tools/, 'the official tools are named')
  assert.doesNotMatch(statOnly, /call those APIs/, 'the pronoun has no referent here')
})

await test('a narrow pool with a loadable file API is told the load order', () => {
  // The acceptance scope: the loader is published and grep is loadable, so the notice
  // must teach load first and call next; a same-program call to grep would throw.
  const narrow = noticeText('bypass', { loader: true, resident: ['ops_inspect_local_file'], loadable: ['ops_grep'] })
  assert.match(narrow, /ops_grep/, 'the loadable file API is named')
  assert.match(narrow, /for the next program/, 'the load lands before the call')
  assert.equal(narrow.includes('ops_edit_file'), false, 'an unauthorized write API is not named')
  assert.equal(narrow.includes('ops_read_files'), false, 'an unloadable read API is not named')
})

report('batching-trigger')
