/**
 * Count every call of a tool this plugin publishes, in every mode.
 *
 * One global `tools/execute` listener observes the dispatch result of each
 * `ops_*` call (including `ops_cu_*`), whichever mode or preset published it and
 * whether the model called it directly or a `run_code` program did. It never
 * changes the result, and a failure to count is swallowed: usage must not be
 * able to fail a call.
 *
 * @module dsh-ops/usage/hook
 */
import type { Context } from '../adapter/dsh/types.js'
import { publicToolName } from '../policy.js'
import { UsageStore, type UsageEvent } from './store.js'

const PREFIX = publicToolName('')
const FAILED_STATUSES = new Set(['failed', 'error', 'rejected'])

interface Exec { name?: unknown; parent?: unknown }
interface Result { isError?: boolean; value?: unknown; content?: readonly { type?: string; text?: unknown }[] }

let store: UsageStore | undefined

/** The process-wide store, created on first use. */
export function usageStore(): UsageStore {
  return (store ??= new UsageStore())
}

/** Replace the process-wide store (tests); returns the previous one. */
export function setUsageStore(next: UsageStore | undefined): UsageStore | undefined {
  const previous = store
  store = next
  return previous
}

/** Whether a dispatch result is a failure: a host failure, or a tool's returned failure value. */
export function failed(result: Result | undefined): boolean {
  if (!result || result.isError) return true
  const status = (result.value as { status?: unknown } | null | undefined)?.status
  return typeof status === 'string' && FAILED_STATUSES.has(status)
}

/** Characters of text the result hands its reader. */
export function outputChars(result: Result | undefined): number {
  let total = 0
  for (const block of result?.content ?? []) if (block?.type === 'text' && typeof block.text === 'string') total += block.text.length
  return total
}

/**
 * Install the counting listener.
 * @param ctx - the context owning the listener; it is removed with it.
 * @param target - the store to count into; the process-wide store by default.
 */
export function installUsage(ctx: Context, target: () => UsageStore = usageStore): void {
  const on = ctx.on as unknown as (name: string, listener: (exec: Exec, next: () => Promise<Result>) => Promise<Result>, options?: { global?: boolean }) => () => void
  on.call(ctx, 'tools/execute', async (exec, next) => {
    const name = typeof exec?.name === 'string' ? exec.name : ''
    if (!name.startsWith(PREFIX)) return next()
    const started = performance.now()
    let result: Result | undefined
    try {
      result = await next()
      return result
    } finally {
      try {
        const event: UsageEvent = { tool: name, ok: !failed(result), ms: performance.now() - started, outputChars: outputChars(result), viaCode: Boolean(exec.parent) }
        target().record(event)
      } catch {}
    }
  }, { global: true })
  ctx.effect(() => () => { try { target().flush() } catch {} }, 'dsh-ops: usage flush')
}
