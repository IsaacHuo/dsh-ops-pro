/**
 * Wire shapes of the sidebar console, served by the same `opsSettings` remote as
 * the row page. No host value imports: the browser half bundles this file.
 *
 * @module dsh-ops/settings/console-contract
 */
import type { RemoteResult } from '../adapter/dsh/types.js'
import type { ComputerUseStatus } from '../cu/state.js'
import type { UsageSummary } from '../usage/store.js'

/** One editable upstream computer-use setting, derived from the vendored schema. */
export interface CuField {
  key: string
  type: 'boolean' | 'enum' | 'integer' | 'text' | 'shortcut'
  default: unknown
  /** Upstream label, `中文 / English`; the page shows the half for its locale. */
  label: string
  values?: readonly string[]
  min?: number
  max?: number
  maxLength?: number
}

export interface ComputerUseView {
  status: ComputerUseStatus
  /** Editable fields; empty when the vendored schema cannot be loaded. */
  fields: CuField[]
  /** Effective values: field default, then the row's `settings`, then the console file. */
  values: Record<string, unknown>
  /** Keys the console file sets. */
  overrides: string[]
  file: string
  /** Why the console file or the schema could not be read. */
  problem?: string
}

export interface ConsoleSnapshot {
  version: string
  platform: string
  features: { id: string; enabled: boolean }[]
  worker: { available: boolean; detail: string }
  computerUse: ComputerUseView
}

export interface ConsoleSaveResult {
  status: 'applied' | 'saved' | 'failed'
  effectState: 'none' | 'applied'
  message: string
}

export interface ConsoleRemote {
  console(): Promise<RemoteResult<ConsoleSnapshot>>
  usage(days: number): Promise<RemoteResult<UsageSummary>>
  resetUsage(): Promise<RemoteResult<ConsoleSaveResult>>
  /** Replace the console's computer-use settings (`{}` clears them) and restart the runtime. */
  saveComputerUse(settings: Record<string, unknown>): Promise<RemoteResult<ConsoleSaveResult>>
}

/** The usage window a page may ask for. */
export function parseDays(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 30) throw new Error('days must be an integer between 1 and 30')
  return value as number
}

/** A flat settings object: scalars only; the host validates each key against the schema. */
export function parseCuSettings(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a settings object')
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key)) throw new Error(`invalid setting key ${JSON.stringify(key)}`)
    if (!['string', 'number', 'boolean'].includes(typeof item)) throw new Error(`${key} must be a string, number or boolean`)
    out[key] = item
  }
  return out
}
