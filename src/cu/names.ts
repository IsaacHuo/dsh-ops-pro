/**
 * Tool-name mapping between the vendored computer-use server and the names this
 * plugin publishes.
 *
 * The server advertises `windows_computer_use_<action>`; the plugin publishes
 * `ops_cu_<action>` through `publicToolName()`, so every published name keeps
 * the one `ops_` prefix and never collides with a standalone `mcp__wincu__*`
 * install of the same runtime.
 *
 * @module dsh-ops/cu/names
 */
import { publicToolName } from '../policy.js'

/** Prefix of every tool the vendored server advertises. */
export const UPSTREAM_PREFIX = 'windows_computer_use_'
/** Prefix of every tool this plugin publishes for computer use. */
export const PUBLIC_PREFIX = publicToolName('cu_')

/**
 * The published name of one server tool.
 * @param upstream - the name from the server's `tools/list`.
 * @returns `ops_cu_<action>`, or undefined for a name outside the server's namespace.
 */
export function publicCuName(upstream: string): string | undefined {
  if (!upstream.startsWith(UPSTREAM_PREFIX)) return undefined
  const action = upstream.slice(UPSTREAM_PREFIX.length)
  return /^[a-z_]+$/.test(action) ? `${PUBLIC_PREFIX}${action}` : undefined
}

/**
 * The server name behind a published computer-use tool.
 * @param published - an `ops_cu_<action>` name.
 * @returns the server's `windows_computer_use_<action>`, or undefined for any other name.
 */
export function upstreamCuName(published: string): string | undefined {
  if (!published.startsWith(PUBLIC_PREFIX)) return undefined
  const action = published.slice(PUBLIC_PREFIX.length)
  return /^[a-z_]+$/.test(action) ? `${UPSTREAM_PREFIX}${action}` : undefined
}

/** Whether a published tool name belongs to a standalone computer-use install. */
export function isStandaloneCuName(name: string): boolean {
  return /^mcp__[^_]+__windows_computer_use_[a-z_]+$/.test(name)
}
