/**
 * Local test-environment checks. Each check names the suites it decides, so a red suite on a
 * developer machine is attributed to a missing prerequisite before anyone calls it flaky.
 * Pure: filesystem and process access are injected.
 */

/**
 * @param {{ platform: string, arch: string, env: Record<string, string | undefined>,
 *   exists: (file: string) => boolean, list: (dir: string) => string[] | undefined,
 *   run: (command: string, args: string[]) => string | undefined }} io
 * @returns {{ id: string, ok: boolean, detail: string, affects: string[] }[]}
 */
export function envChecks({ platform, arch, env, exists, list, run }) {
  const target = platform + '-' + arch
  const windows = platform === 'win32'
  const checks = []
  const add = (id, ok, detail, affects) => checks.push({ id, ok, detail, affects })
  const worker = env.DSH_OPS_WORKER_BIN ?? 'runtime/' + target + '/dsh-ops-worker' + (windows ? '.exe' : '')
  add('worker', exists(worker), exists(worker) ? worker : worker + ' is missing: run npm run build:ptc', ['most suites (they fail or skip without the worker)'])
  const cargo = run('cargo', ['--version'])
  add('cargo', cargo !== undefined, cargo ?? 'cargo is not on PATH (add ~/.cargo/bin)', ['build:ptc', 'cargo test'])
  if (!windows) return checks
  const ipc = list('runtime/win32-x64/bash-ipc') ?? []
  const dll = ipc.some(name => /\.dll$/iu.test(name))
  add('bash-ipc', dll, dll ? ipc.length + ' staged file(s)' : ipc.length === 0 && list('runtime/win32-x64/bash-ipc') !== undefined
    ? 'runtime/win32-x64/bash-ipc is empty: if build:bash-ipc succeeded, endpoint security removed the DLLs; CI is the reference'
    : 'no Bash IPC payload: run npm run build:bash-ipc', ['bash-ipc', 'bash-ipc-roots', 'permissions'])
  const archive = env.DSH_OPS_NIUBASH_ARCHIVE
  const staged = (list('dist/downloads') ?? []).find(name => /^niubash-.*\.tar\.gz$/u.test(name))
  add('niubash-archive', archive !== undefined && exists(archive), archive !== undefined && exists(archive) ? archive
    : staged ? 'set DSH_OPS_NIUBASH_ARCHIVE=dist/downloads/' + staged : 'no Niubash archive in dist/downloads', ['niubash-*'])
  const bash = env.DSH_OPS_TEST_BASH
  add('test-bash', bash !== undefined && exists(bash), bash !== undefined && exists(bash) ? bash
    : 'set DSH_OPS_TEST_BASH to a managed bash.exe (an unset or stale path makes test/run.mjs throw ENOENT)', ['shells-*', 'linux-shell'])
  return checks
}

/** One line per check, failing checks first. */
export function renderChecks(checks) {
  return [...checks].sort((a, b) => Number(a.ok) - Number(b.ok))
    .map(check => (check.ok ? 'ok    ' : 'MISS  ') + check.id.padEnd(16) + check.detail + (check.ok ? '' : '  [affects: ' + check.affects.join(', ') + ']'))
    .join('\n')
}
