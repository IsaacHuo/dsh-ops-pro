/**
 * A minimal JSON-RPC 2.0 client over a child process's stdio, newline framed.
 *
 * It speaks exactly what the vendored computer-use server needs: requests with
 * a deadline and caller cancellation (forwarded as `notifications/cancelled`),
 * notifications, and a process exit that settles every pending request instead
 * of leaving it hanging. It is not a general MCP client.
 *
 * @module dsh-ops/cu/rpc-client
 */
import { spawn, type ChildProcess } from 'node:child_process'

/** How to start the server. */
export interface SpawnSpec {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string | undefined>>
  readonly cwd?: string
}

/** A request that did not produce a JSON-RPC result. */
export class RpcFailure extends Error {
  constructor(readonly code: 'RPC_TIMEOUT' | 'RPC_CANCELLED' | 'RPC_EXITED' | 'RPC_ERROR', message: string) { super(message) }
}

interface Pending {
  resolve(value: unknown): void
  reject(error: RpcFailure): void
  cleanup(): void
}

const STDERR_TAIL = 4096

/** One running server process. */
export class StdioRpcClient {
  private readonly child: ChildProcess
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private buffer = ''
  private stderr = ''
  private exited: string | undefined

  /**
   * Start the process.
   * @param spec - command, arguments and environment.
   * @param onExit - called once when the process ends, with a one-line reason.
   */
  constructor(spec: SpawnSpec, private readonly onExit: (reason: string) => void = () => {}) {
    this.child = spawn(spec.command, [...spec.args], { cwd: spec.cwd, env: spec.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child.stdout!.setEncoding('utf8')
    this.child.stdout!.on('data', (chunk: string) => this.ingest(chunk))
    this.child.stderr!.setEncoding('utf8')
    this.child.stderr!.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL) })
    // A write to a closed pipe surfaces as an exit below; never as an unhandled error.
    this.child.stdin!.on('error', () => {})
    this.child.on('error', error => this.finish(`spawn failed: ${error.message}`))
    this.child.on('exit', (code, signal) => this.finish(`exited with ${signal ?? `code ${code}`}`))
  }

  /** Whether the process is still running. */
  get alive(): boolean { return this.exited === undefined }

  /** The process id, when it started. */
  get pid(): number | undefined { return this.child.pid }

  /** The last lines the process wrote to stderr. */
  get stderrTail(): string { return this.stderr }

  /**
   * Send one request.
   * @param method - the JSON-RPC method.
   * @param params - its params object.
   * @param options - deadline and caller cancellation.
   * @returns the result; rejects with an {@link RpcFailure}.
   */
  request(method: string, params: Record<string, unknown>, options: { timeoutMs: number; signal?: AbortSignal }): Promise<unknown> {
    if (this.exited !== undefined) return Promise.reject(new RpcFailure('RPC_EXITED', `computer-use server ${this.exited}`))
    if (options.signal?.aborted) return Promise.reject(new RpcFailure('RPC_CANCELLED', 'cancelled before the request was sent'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.cancel(id); settle(new RpcFailure('RPC_TIMEOUT', `${method} timed out after ${options.timeoutMs} ms`)) }, options.timeoutMs)
      const abort = () => { this.cancel(id); settle(new RpcFailure('RPC_CANCELLED', `${method} was cancelled`)) }
      options.signal?.addEventListener('abort', abort, { once: true })
      const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort) }
      const settle = (error: RpcFailure) => { const entry = this.pending.get(id); if (!entry) return; this.pending.delete(id); cleanup(); reject(error) }
      this.pending.set(id, { resolve, reject, cleanup })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  /** Send one notification. */
  notify(method: string, params: Record<string, unknown> = {}): void {
    if (this.exited === undefined) this.write({ jsonrpc: '2.0', method, params })
  }

  /**
   * Stop the process: close stdin so the server finishes its own shutdown, then
   * kill it if it is still running after the grace period.
   */
  async close(graceMs = 3000): Promise<void> {
    if (this.exited !== undefined) return
    const exited = new Promise<void>(resolve => this.child.once('exit', () => resolve()))
    this.child.stdin!.end()
    const timer = setTimeout(() => { try { this.child.kill() } catch {} }, graceMs)
    timer.unref?.()
    await exited
    clearTimeout(timer)
  }

  private cancel(id: number): void {
    if (this.pending.has(id)) this.notify('notifications/cancelled', { requestId: id, reason: 'host cancelled' })
  }

  private write(message: unknown): void {
    this.child.stdin!.write(`${JSON.stringify(message)}\n`)
  }

  private ingest(chunk: string): void {
    this.buffer += chunk
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) this.dispatch(line)
    }
  }

  private dispatch(line: string): void {
    let message: { id?: unknown; result?: unknown; error?: { message?: unknown } }
    try { message = JSON.parse(line) } catch { return }
    if (typeof message?.id !== 'number') return
    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)
    entry.cleanup()
    if (message.error) entry.reject(new RpcFailure('RPC_ERROR', String(message.error.message ?? 'JSON-RPC error')))
    else entry.resolve(message.result)
  }

  private finish(reason: string): void {
    if (this.exited !== undefined) return
    this.exited = reason
    for (const [id, entry] of this.pending) {
      this.pending.delete(id)
      entry.cleanup()
      entry.reject(new RpcFailure('RPC_EXITED', `computer-use server ${reason}`))
    }
    this.onExit(reason)
  }
}
