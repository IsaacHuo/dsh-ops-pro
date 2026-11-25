/**
 * Lifecycle of the one vendored computer-use server this row owns.
 *
 * The server is persistent (its UI Automation backend and browser lane keep
 * state between calls), so it is started once, on demand, and kept. A crash is
 * restarted lazily by the next call, but only once per {@link RESTART_WINDOW_MS}:
 * a server that dies again right after a restart stays down and every call says
 * why, instead of looping a crashing process.
 *
 * @module dsh-ops/cu/server
 */
import { RpcFailure, StdioRpcClient, type SpawnSpec } from './rpc-client.js'

/** One tool as the server advertises it. */
export interface ServerTool {
  readonly name: string
  readonly description?: string
  readonly inputSchema?: Record<string, unknown>
}

/** The `tools/call` result. */
export interface ServerCallResult {
  readonly isError?: boolean
  readonly content?: readonly { type?: string; text?: string }[]
}

/** What the console shows. */
export interface ServerSnapshot {
  readonly state: 'idle' | 'starting' | 'running' | 'failed'
  readonly pid?: number
  readonly starts: number
  readonly lastExit?: string
  readonly stderrTail?: string
}

/** A crash inside this window after a start is not restarted again. */
export const RESTART_WINDOW_MS = 60000
const PROTOCOL_VERSION = '2025-06-18'
const HANDSHAKE_TIMEOUT_MS = 20000

/** Owns start, restart and shutdown of the server process. */
export class ComputerUseServer {
  private client: StdioRpcClient | undefined
  private starting: Promise<StdioRpcClient> | undefined
  private starts = 0
  private startedAt = 0
  private lastExit: string | undefined
  private lastStderr: string | undefined
  private stopped = false
  private down: string | undefined

  /**
   * @param spec - builds the spawn spec; called on every start so settings changes apply.
   * @param version - this plugin's version, sent as the client version.
   * @param now - clock, replaceable in tests.
   */
  constructor(private readonly spec: () => SpawnSpec, private readonly version: string, private readonly now: () => number = Date.now) {}

  /** Current state for diagnostics. */
  snapshot(): ServerSnapshot {
    const state = this.down ? 'failed' : this.starting ? 'starting' : this.client?.alive ? 'running' : 'idle'
    return { state, starts: this.starts, ...(this.client?.alive && this.client.pid ? { pid: this.client.pid } : {}),
      ...(this.lastExit ? { lastExit: this.lastExit } : {}), ...(this.lastStderr ? { stderrTail: this.lastStderr } : {}) }
  }

  /** Start the server if it is not running; rejects with the reason it cannot run. */
  async ready(): Promise<void> {
    await this.ensure()
  }

  /** List the tools the server advertises, starting it if needed. */
  async listTools(): Promise<ServerTool[]> {
    const client = await this.ensure()
    const result = await client.request('tools/list', {}, { timeoutMs: HANDSHAKE_TIMEOUT_MS }) as { tools?: unknown }
    return Array.isArray(result?.tools) ? result.tools.filter((tool): tool is ServerTool => typeof tool?.name === 'string') : []
  }

  /**
   * Call one tool.
   * @param name - the server-side tool name.
   * @param args - arguments, already approved by the host policy.
   * @param options - deadline and caller cancellation.
   */
  async call(name: string, args: Record<string, unknown>, options: { timeoutMs: number; signal?: AbortSignal }): Promise<ServerCallResult> {
    const client = await this.ensure()
    return await client.request('tools/call', { name, arguments: args }, options) as ServerCallResult
  }

  /** Stop the server for good (row teardown). */
  async dispose(): Promise<void> {
    this.stopped = true
    const client = this.client
    this.client = undefined
    await client?.close()
  }

  private async ensure(): Promise<StdioRpcClient> {
    if (this.stopped) throw new RpcFailure('RPC_EXITED', 'the computer-use row is unloading')
    if (this.client?.alive) return this.client
    if (this.starting) return this.starting
    if (this.down) throw new RpcFailure('RPC_EXITED', this.down)
    if (this.starts > 0 && this.now() - this.startedAt < RESTART_WINDOW_MS && this.starts >= 2) {
      this.down = `computer-use server stopped twice within ${RESTART_WINDOW_MS / 1000} s (${this.lastExit ?? 'unknown exit'}); reload the plugin to retry`
      throw new RpcFailure('RPC_EXITED', this.down)
    }
    this.starting = this.start().finally(() => { this.starting = undefined })
    return this.starting
  }

  private async start(): Promise<StdioRpcClient> {
    // A second start inside the window is the one allowed restart; a start after
    // a quiet window resets the count.
    if (this.now() - this.startedAt >= RESTART_WINDOW_MS) this.starts = 0
    this.starts += 1
    this.startedAt = this.now()
    const client = new StdioRpcClient(this.spec(), reason => {
      this.lastExit = reason
      this.lastStderr = client.stderrTail.trim().split(/\r?\n/).slice(-5).join('\n') || undefined
      if (this.client === client) this.client = undefined
    })
    try {
      await client.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {},
        clientInfo: { name: 'dsh-ops-pro', version: this.version } }, { timeoutMs: HANDSHAKE_TIMEOUT_MS })
      client.notify('notifications/initialized')
    } catch (error) {
      await client.close(500)
      throw error
    }
    if (this.stopped) { await client.close(); throw new RpcFailure('RPC_EXITED', 'the computer-use row is unloading') }
    this.client = client
    return client
  }
}
