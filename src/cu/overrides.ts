/**
 * Console-owned computer-use settings: `<DSH_HOME>/dsh-ops/computer-use.json`.
 *
 * The row page only owns the on/off switch; the detailed upstream settings are
 * edited from the sidebar console and kept in this one plugin-owned file, so the
 * console never rewrites the host profile. Keys here win over the row's own
 * `settings` slice. Validation is the vendored runtime's (`validateSetting`),
 * applied by the writer; a reader that finds an unreadable file reports it and
 * falls back to no overrides instead of failing the row.
 *
 * @module dsh-ops/cu/overrides
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { dshHome } from '../paths.js'

export type CuSettings = Record<string, unknown>

/** Where the console keeps its computer-use settings. */
export function overridesFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dshHome(env), 'dsh-ops', 'computer-use.json')
}

/** The saved overrides; `error` names an unreadable file (and the settings are then empty). */
export function readOverrides(file: string = overridesFile()): { settings: CuSettings; error?: string } {
  let text: string
  try { text = readFileSync(file, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { settings: {} }
    return { settings: {}, error: `cannot read ${file}: ${(error as Error).message}` }
  }
  try {
    const value = JSON.parse(text) as { settings?: unknown }
    const settings = value?.settings
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('expected {"settings": {...}}')
    return { settings: { ...(settings as CuSettings) } }
  } catch (error) { return { settings: {}, error: `ignoring ${file}: ${(error as Error).message}` } }
}

/** Replace the overrides atomically; an empty object removes the file. */
export function writeOverrides(settings: CuSettings, file: string = overridesFile()): void {
  if (Object.keys(settings).length === 0) { rmSync(file, { force: true }); return }
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify({ settings }, null, 2)}\n`)
  renameSync(temp, file)
}
