/**
 * The `computer-use` section of the row.
 *
 * Only two keys are this plugin's own: `callTimeoutMs` (the host-side deadline of
 * one call) and `settings`, the vendored server's settings object. The settings
 * keys belong to the vendored runtime and are validated by its own
 * `normalizeSettings` when the server starts; here they are checked only for
 * shape, so a profile saved against a newer runtime is never refused by this
 * plugin's resolver.
 *
 * @module dsh-ops/cu/config
 */
import { ConfigError } from '../config/resolve.js'

/** The resolved section. */
export interface ComputerUseConfig {
  /** Vendored server settings, handed to its `normalizeSettings` unchanged. */
  readonly settings: Readonly<Record<string, unknown>>
  /** Host-side deadline of one tool call, in milliseconds. */
  readonly callTimeoutMs: number
}

/** The upstream adapter's default: `wait_for` accepts 60 s, plus backend start-up. */
export const DEFAULT_CALL_TIMEOUT_MS = 90000

const KEYS = ['settings', 'callTimeoutMs']

function scalarOrList(value: unknown): boolean {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

/**
 * Validate the section's own keys.
 * @param raw - the section without `enabled`.
 * @returns the resolved section.
 * @throws ConfigError naming the key that failed.
 */
export function resolveComputerUseConfig(raw: unknown): ComputerUseConfig {
  if (raw === undefined || raw === null) return { settings: {}, callTimeoutMs: DEFAULT_CALL_TIMEOUT_MS }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('computer-use must be an object')
  const input = raw as Record<string, unknown>
  for (const key of Object.keys(input)) {
    if (!KEYS.includes(key)) throw new ConfigError(`unknown computer-use key ${JSON.stringify(key)}; accepted keys are enabled, ${KEYS.join(', ')}`)
  }
  const timeout = input.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1000 || timeout > 600000) {
    throw new ConfigError('computer-use.callTimeoutMs must be an integer from 1000 to 600000')
  }
  const settings = input.settings ?? {}
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) throw new ConfigError('computer-use.settings must be an object')
  for (const [key, value] of Object.entries(settings)) {
    if (!scalarOrList(value)) throw new ConfigError(`computer-use.settings.${key} must be a string, number, boolean, null or a list of strings`)
  }
  return { settings: Object.freeze({ ...settings as Record<string, unknown> }), callTimeoutMs: timeout }
}
