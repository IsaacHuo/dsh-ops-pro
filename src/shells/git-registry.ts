/**
 * Git for Windows install roots the installer recorded in the registry.
 *
 * The installer writes `InstallPath` under `SOFTWARE\GitForWindows` whatever drive
 * the operator chose, so a copy on `D:\Git` is found even though neither the
 * conventional locations nor PATH (which only gains `<root>\cmd`) name its bash.
 * Only the executor candidate list reads this; resolution never selects a system
 * Git implicitly.
 *
 * @module dsh-ops/shells/git-registry
 */

import { execFileSync } from 'node:child_process'
import path from 'node:path'

/** The keys the machine-wide, per-user and 32-bit installers write, in probe order. */
export const GIT_FOR_WINDOWS_KEYS = Object.freeze([
  'HKLM\\SOFTWARE\\GitForWindows',
  'HKCU\\SOFTWARE\\GitForWindows',
  'HKLM\\SOFTWARE\\WOW6432Node\\GitForWindows',
])

/** Reads one key's `InstallPath` value; answers the raw `reg query` output or undefined. */
export type RegistryQuery = (key: string) => string | undefined

/**
 * The `InstallPath` value inside one `reg query <key> /v InstallPath` answer.
 * @param output - the command's standard output.
 * @returns the absolute install root, or undefined when absent or not absolute.
 */
export function parseInstallPath(output: string | undefined): string | undefined {
  const match = /^\s*InstallPath\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(output ?? '')
  const value = match?.[1]
  return value !== undefined && path.win32.isAbsolute(value) ? path.win32.normalize(value) : undefined
}

/** The real reader: the system `reg.exe`, hidden, bounded, and silent on a missing key. */
function queryRegistry(env: NodeJS.ProcessEnv): RegistryQuery {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows'
  const reg = path.win32.join(systemRoot, 'System32', 'reg.exe')
  return key => {
    try {
      return execFileSync(reg, ['query', key, '/v', 'InstallPath'],
        { encoding: 'utf8', windowsHide: true, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch { return undefined }
  }
}

/**
 * The bash executables under every recorded Git for Windows root, whether or not they exist.
 * @param options.platform - `process.platform`; only win32 has a registry.
 * @param options.env - the environment (for `SystemRoot`).
 * @param options.query - the registry reader; tests inject one.
 * @returns `<root>\bin\bash.exe` then `<root>\usr\bin\bash.exe` for each distinct root.
 */
export function registryGitBash({ platform, env, query }: { platform: string; env: NodeJS.ProcessEnv; query?: RegistryQuery }): string[] {
  if (platform !== 'win32') return []
  const read = query ?? queryRegistry(env)
  const roots = new Set<string>()
  for (const key of GIT_FOR_WINDOWS_KEYS) {
    const root = parseInstallPath(read(key))
    if (root !== undefined) roots.add(root)
  }
  return [...roots].flatMap(root => [path.win32.join(root, 'bin', 'bash.exe'), path.win32.join(root, 'usr', 'bin', 'bash.exe')])
}
