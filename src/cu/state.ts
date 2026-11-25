/**
 * Process-wide view of the computer-use row, read by the console and `ops_status`.
 *
 * The row is mounted at most once per host, so one slot is enough; the row
 * clears it on teardown, and a reader sees `disabled` while no row is mounted.
 *
 * @module dsh-ops/cu/state
 */
import type { ServerSnapshot } from './server.js'

/** What a reader sees. */
export interface ComputerUseStatus {
  readonly state: 'disabled' | 'unsupported' | 'starting' | 'ready' | 'failed'
  /** Published tool names, sorted. */
  readonly tools: readonly string[]
  /** A standalone dsh-computer-use-win install publishes the same runtime as `mcp__*__windows_computer_use_*`. */
  readonly conflict: boolean
  /** The UI Automation backend script is absent (endpoint security quarantines it on some machines). */
  readonly backendMissing: boolean
  readonly message?: string
  readonly server?: ServerSnapshot
}

const DISABLED: ComputerUseStatus = Object.freeze({ state: 'disabled', tools: [], conflict: false, backendMissing: false })
let current: (() => ComputerUseStatus) | undefined

/** Install the live reader of a mounted row; returns its remover. */
export function publishComputerUseStatus(reader: () => ComputerUseStatus): () => void {
  current = reader
  return () => { if (current === reader) current = undefined }
}

/** The current status; `disabled` while no row is mounted. */
export function computerUseStatus(): ComputerUseStatus {
  try { return current?.() ?? DISABLED } catch (error) {
    return { ...DISABLED, state: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}
