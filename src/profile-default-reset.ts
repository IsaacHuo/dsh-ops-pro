/**
 * Clear a profile's `selectedDefault: ops-ptc` once the plugin that publishes
 * `ops-ptc` is gone (#881, #928).
 *
 * The plugin cannot do this itself: writing settings while its row is being
 * disposed fails with "HMR transactions cannot be nested", and after a real
 * removal no plugin code runs at all. So the profile CLI does it after the
 * official manager removed the bundle, and `repair-default` covers a removal
 * made from the GUI.
 *
 * The edit is deliberately narrow and dependency-free: it only recognises the
 * layout the host's settings service writes (a top-level list entry
 * `- id: agent-preset-registry` with a `config:` map indented by two and its
 * keys by four spaces). Anything else is reported as `unrecognised` and the
 * file is left untouched, with manual instructions.
 * @module dsh-ops/profile-default-reset
 */
import fs from 'node:fs'
import path from 'node:path'

/** The preset id this plugin publishes. */
export const OPS_PRESET_ID = 'ops-ptc'
/** The registry row whose config carries `selectedDefault`. */
export const REGISTRY_ROW_ID = 'agent-preset-registry'
/** The profile file the host settings service writes. */
export const PROFILE_PATCH_FILE = 'cordis.patch.yml'

/** What a reset found. */
export type DefaultResetStatus = 'reset' | 'absent' | 'other' | 'unrecognised'

export interface DefaultResetResult {
  readonly status: DefaultResetStatus
  /** The rewritten text (equal to the input unless status is `reset`). */
  readonly text: string
  /** The value found, when there was one. */
  readonly value?: string
  /** Why the layout was not recognised. */
  readonly reason?: string
}

const ENTRY_START = /^- /
const ROW_LINE = new RegExp(`^- id: ["']?${REGISTRY_ROW_ID}["']?\\s*$`)
const CONFIG_LINE = /^ {2}config:\s*$/
const SELECTED_LINE = /^ {4}selectedDefault:\s*(.*?)\s*$/

/** Strip one pair of matching YAML quotes; refuse anything with escapes or comments. */
function scalar(raw: string): string | undefined {
  const quoted = /^(["'])(.*)\1$/.exec(raw)
  const value = quoted ? quoted[2] : raw
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : undefined
}

/**
 * Remove `selectedDefault: ops-ptc` from the registry row of one profile patch.
 * @param text - the profile patch file contents.
 * @returns the verdict and the (possibly) rewritten text; line endings are kept.
 */
export function resetStaleDefaultText(text: string): DefaultResetResult {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(eol)
  const rows = lines.flatMap((line, index) => ROW_LINE.test(line) ? [index] : [])
  if (rows.length === 0) {
    // A row named some other way still counts as unrecognised, never as absent.
    return lines.some(line => line.includes(REGISTRY_ROW_ID))
      ? { status: 'unrecognised', text, reason: `the ${REGISTRY_ROW_ID} row is not written as "- id: ${REGISTRY_ROW_ID}"` }
      : { status: 'absent', text }
  }
  if (rows.length > 1) return { status: 'unrecognised', text, reason: `${REGISTRY_ROW_ID} appears ${rows.length} times` }
  const start = rows[0]!
  let end = lines.length
  for (let index = start + 1; index < lines.length; index++) if (ENTRY_START.test(lines[index]!)) { end = index; break }
  const hits: number[] = []
  let config = -1
  for (let index = start + 1; index < end; index++) {
    const line = lines[index]!
    if (CONFIG_LINE.test(line)) config = index
    else if (line.includes('selectedDefault')) {
      if (config < 0 || !SELECTED_LINE.test(line)) return { status: 'unrecognised', text, reason: `selectedDefault is not a four-space key under "  config:" (line ${index + 1})` }
      hits.push(index)
    }
  }
  if (hits.length === 0) return { status: 'absent', text }
  if (hits.length > 1) return { status: 'unrecognised', text, reason: 'selectedDefault appears more than once' }
  const at = hits[0]!
  const value = scalar(SELECTED_LINE.exec(lines[at]!)![1]!)
  if (value === undefined) return { status: 'unrecognised', text, reason: `selectedDefault is not a plain value (line ${at + 1})` }
  if (value !== OPS_PRESET_ID) return { status: 'other', text, value }
  lines.splice(at, 1)
  // When it was the only key, keep the map a map rather than leaving a null config.
  const next = lines[config + 1]
  if (next === undefined || !/^ {4}\S/.test(next)) lines[config] = '  config: {}'
  return { status: 'reset', text: lines.join(eol), value }
}

/**
 * Apply {@link resetStaleDefaultText} to a profile directory.
 * @param directory - the profile directory (`<DSH_HOME>/profiles/<name>`).
 * @param options.dryRun - report without writing.
 * @returns the verdict; the file is rewritten only for `reset` without dry run.
 */
export function resetStaleDefault(directory: string, { dryRun = false }: { dryRun?: boolean } = {}): DefaultResetResult & { file: string } {
  const file = path.join(directory, PROFILE_PATCH_FILE)
  let text: string
  try { text = fs.readFileSync(file, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent', text: '', file }
    throw error
  }
  const result = resetStaleDefaultText(text)
  if (result.status === 'reset' && !dryRun) {
    // Write a sibling and rename over the original so a crash never leaves half a profile.
    const temp = `${file}.dsh-ops-${process.pid}.tmp`
    fs.writeFileSync(temp, result.text)
    fs.renameSync(temp, file)
  }
  return { ...result, file }
}

/**
 * Print one verdict for the operator.
 * @returns the exit code: 1 only for `unrecognised`.
 */
export function reportDefaultReset(result: DefaultResetResult & { file: string }, dryRun: boolean): number {
  switch (result.status) {
    case 'reset':
      console.log(`Default preset: ${dryRun ? 'would clear' : 'cleared'} selectedDefault: ${OPS_PRESET_ID} in ${result.file}; new sessions fall back to the registry default.`)
      return 0
    case 'absent':
      console.log('Default preset: no selectedDefault override; nothing to clear.')
      return 0
    case 'other':
      console.log(`Default preset: selectedDefault is ${result.value}, not ${OPS_PRESET_ID}; left unchanged.`)
      return 0
    case 'unrecognised':
      console.error(`Default preset: left ${result.file} unchanged because ${result.reason}. If it still names ${OPS_PRESET_ID}, pick another default in Settings -> Agent presets, or delete the selectedDefault line under ${REGISTRY_ROW_ID}.`)
      return 1
  }
}
