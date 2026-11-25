/**
 * Host half of the sidebar console: one snapshot of what is running, the usage
 * counters, and the computer-use settings the console owns.
 *
 * Everything reported is read from the live process (the mounted row config, the
 * worker resolution, the computer-use row's own status) — nothing is inferred.
 *
 * @module dsh-ops/settings/console-actions
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { RUNTIME_DIR } from '../components/computer-use/index.js'
import { overridesFile, readOverrides, writeOverrides } from '../cu/overrides.js'
import { computerUseStatus, restartComputerUse } from '../cu/state.js'
import { tryResolveWorker } from '../execution/runtime.js'
import { PACKAGE_ROOT } from '../paths.js'
import { usageStore } from '../usage/hook.js'
import type { UsageStore, UsageSummary } from '../usage/store.js'
import { FEATURES, resolveMergedConfig } from './merged.js'
import type { ComputerUseView, ConsoleSaveResult, ConsoleSnapshot, CuField } from './console-contract.js'

interface SchemaField { type: string; default: unknown; description?: string; draft?: boolean; command?: boolean; values?: readonly string[]; min?: number; max?: number; maxLength?: number }
interface VendorSchema { SETTINGS_SCHEMA: Record<string, SchemaField>; validateSetting(key: string, value: unknown): void }

const EDITABLE = new Set(['boolean', 'enum', 'integer', 'text', 'shortcut'])

export interface ConsoleOptions {
  /** The composed row configuration the mounted fiber owns. */
  config?: () => unknown
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  runtimeDir?: string
  usage?: () => UsageStore
  restart?: () => Promise<boolean>
}

/** The fields the console may edit: drafts of a plain type, never commands or tool lists. */
export function editableFields(schema: Record<string, SchemaField>): CuField[] {
  return Object.entries(schema).filter(([, field]) => field.draft !== false && !field.command && EDITABLE.has(field.type))
    .map(([key, field]) => ({ key, type: field.type as CuField['type'], default: field.default, label: field.description ?? key,
      ...(field.values ? { values: [...field.values] } : {}), ...(field.min === undefined ? {} : { min: field.min }),
      ...(field.max === undefined ? {} : { max: field.max }), ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }) }))
}

export class ConsoleActions {
  private readonly options: Required<Omit<ConsoleOptions, 'config'>> & Pick<ConsoleOptions, 'config'>
  constructor(options: ConsoleOptions = {}) {
    this.options = { env: process.env, platform: process.platform, runtimeDir: RUNTIME_DIR, usage: usageStore, restart: restartComputerUse, ...options }
  }

  private async schema(): Promise<VendorSchema> {
    return await import(pathToFileURL(path.join(this.options.runtimeDir, 'mcp', 'settings-schema.mjs')).href) as VendorSchema
  }

  private rowSettings(): Record<string, unknown> {
    try {
      const merged = resolveMergedConfig(this.options.config?.())
      const raw = (merged['computer-use'] as { config?: { settings?: Record<string, unknown> } }).config?.settings
      return raw ?? {}
    } catch { return {} }
  }

  async snapshot(): Promise<ConsoleSnapshot> {
    let features: ConsoleSnapshot['features'] = []
    try {
      const merged = resolveMergedConfig(this.options.config?.()) as unknown as Record<string, { enabled?: unknown }>
      features = FEATURES.flatMap(id => typeof merged[id]?.enabled === 'boolean' ? [{ id, enabled: merged[id].enabled as boolean }] : [])
    } catch { features = [] }
    const worker = tryResolveWorker({}, { env: this.options.env, platform: this.options.platform })
    return {
      version: packageVersion(), platform: this.options.platform, features,
      worker: worker.ok ? { available: true, detail: worker.file } : { available: false, detail: worker.reason.split('\n')[0] ?? '' },
      computerUse: await this.computerUse(),
    }
  }

  private async computerUse(): Promise<ComputerUseView> {
    const file = overridesFile(this.options.env)
    const saved = readOverrides(file)
    const problems = saved.error ? [saved.error] : []
    let fields: CuField[] = []
    try { fields = editableFields((await this.schema()).SETTINGS_SCHEMA) } catch (error) {
      problems.push(`computer-use settings schema unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
    const row = this.rowSettings()
    const values: Record<string, unknown> = {}
    for (const field of fields) values[field.key] = saved.settings[field.key] ?? row[field.key] ?? field.default
    return { status: computerUseStatus(), fields, values, overrides: Object.keys(saved.settings).sort(), file,
      ...(problems.length ? { problem: problems.join('; ') } : {}) }
  }

  usage(days: number): UsageSummary { return this.options.usage().summary(days) }

  resetUsage(): ConsoleSaveResult {
    this.options.usage().reset()
    return { status: 'applied', effectState: 'applied', message: 'usage counters cleared' }
  }

  /** Validate every key with the vendored rules, then replace the file and restart the runtime. */
  async saveComputerUse(settings: Record<string, unknown>): Promise<ConsoleSaveResult> {
    let schema: VendorSchema
    try { schema = await this.schema() } catch (error) {
      return { status: 'failed', effectState: 'none', message: `computer-use runtime is not built: ${error instanceof Error ? error.message : String(error)}` }
    }
    const allowed = new Set(editableFields(schema.SETTINGS_SCHEMA).map(field => field.key))
    try {
      for (const [key, value] of Object.entries(settings)) {
        if (!allowed.has(key)) throw new Error(`${key} cannot be set from the console`)
        schema.validateSetting(key, value)
      }
    } catch (error) { return { status: 'failed', effectState: 'none', message: error instanceof Error ? error.message : String(error) } }
    try { writeOverrides(settings, overridesFile(this.options.env)) } catch (error) {
      return { status: 'failed', effectState: 'none', message: `cannot save: ${error instanceof Error ? error.message : String(error)}` }
    }
    try {
      const restarted = await this.options.restart()
      return restarted
        ? { status: 'applied', effectState: 'applied', message: 'saved; the computer-use runtime restarted with these settings' }
        : { status: 'saved', effectState: 'applied', message: 'saved; it applies when computer use is next enabled' }
    } catch (error) {
      return { status: 'failed', effectState: 'applied', message: `saved, but the restart failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
}

function packageVersion(): string {
  try { return String(JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version) } catch { return 'unknown' }
}
