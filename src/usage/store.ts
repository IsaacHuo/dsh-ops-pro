/**
 * Per-day usage counters of the tools this plugin publishes.
 *
 * WHAT IS COUNTED, AND WHAT IS NOT
 *
 * Calls, failures, wall time and the characters each result handed the model
 * (or the calling `run_code` program). Token figures shown from these counters
 * are an estimate (characters / 4), never a billing number: the host does not
 * attribute model tokens to individual tools.
 *
 * STORAGE
 *
 * One JSON file, `<DSH_HOME>/dsh-ops/usage.json`, one bucket per local day,
 * days older than {@link RETENTION_DAYS} dropped on every write. Writes are
 * throttled to one per {@link FLUSH_MS} and are atomic (temp file + rename). A
 * store that cannot be read or written keeps counting in memory: usage is a
 * convenience and must never fail a tool call.
 *
 * @module dsh-ops/usage/store
 */
import fs from 'node:fs'
import path from 'node:path'
import { dshHome } from '../paths.js'

/** Days kept. */
export const RETENTION_DAYS = 30
/** Minimum gap between two writes. */
export const FLUSH_MS = 5000
/** Durations kept per tool and day for percentiles. */
export const DURATION_SAMPLES = 256
const VERSION = 1

/** One tool on one day. */
export interface ToolDay {
  calls: number
  failed: number
  /** Calls made from a `run_code` program rather than by the model directly. */
  viaCode: number
  totalMs: number
  outputChars: number
  /** A bounded sample of call durations, in milliseconds. */
  durations: number[]
}

/** One recorded call. */
export interface UsageEvent {
  readonly tool: string
  readonly ok: boolean
  readonly ms: number
  readonly outputChars: number
  readonly viaCode: boolean
}

/** One tool over a window. */
export interface ToolSummary {
  readonly tool: string
  readonly calls: number
  readonly failed: number
  readonly viaCode: number
  readonly outputChars: number
  readonly estimatedTokens: number
  readonly p50Ms: number
  readonly p95Ms: number
}

/** A window of days. */
export interface UsageSummary {
  readonly days: number
  readonly from: string
  readonly to: string
  readonly calls: number
  readonly failed: number
  readonly outputChars: number
  readonly estimatedTokens: number
  /** Calls per day, oldest first, one entry per day of the window. */
  readonly daily: readonly { day: string; calls: number; failed: number }[]
  readonly tools: readonly ToolSummary[]
  /** Why the file could not be used, while counting continues in memory. */
  readonly storeError?: string
}

type Days = Record<string, Record<string, ToolDay>>

/** The local calendar day of a timestamp, `YYYY-MM-DD`. */
export function localDay(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]!
}

function validDay(value: unknown): value is ToolDay {
  const day = value as ToolDay
  return Boolean(day) && typeof day === 'object' && ['calls', 'failed', 'viaCode', 'totalMs', 'outputChars'].every(key => Number.isFinite((day as unknown as Record<string, unknown>)[key]))
    && Array.isArray(day.durations)
}

/** The counters, their file and their write throttle. */
export class UsageStore {
  private days: Days = {}
  private dirty = false
  private timer: NodeJS.Timeout | undefined
  private lastFlush = 0
  private error: string | undefined

  /**
   * @param file - the JSON file; defaults to `<DSH_HOME>/dsh-ops/usage.json`.
   * @param now - clock, replaceable in tests.
   */
  constructor(readonly file: string = path.join(dshHome(), 'dsh-ops', 'usage.json'), private readonly now: () => number = Date.now) {
    this.load()
  }

  /** Count one call. Never throws. */
  record(event: UsageEvent): void {
    const day = (this.days[localDay(this.now())] ??= {})
    const entry = (day[event.tool] ??= { calls: 0, failed: 0, viaCode: 0, totalMs: 0, outputChars: 0, durations: [] })
    entry.calls += 1
    if (!event.ok) entry.failed += 1
    if (event.viaCode) entry.viaCode += 1
    const ms = Math.max(0, Math.round(event.ms))
    entry.totalMs += ms
    entry.outputChars += Math.max(0, Math.round(event.outputChars))
    // Reservoir-free bounded sample: keep the newest durations.
    entry.durations.push(ms)
    if (entry.durations.length > DURATION_SAMPLES) entry.durations.splice(0, entry.durations.length - DURATION_SAMPLES)
    this.dirty = true
    this.schedule()
  }

  /** Aggregate the last `days` days, today included. */
  summary(days = 7): UsageSummary {
    const window = Math.max(1, Math.min(RETENTION_DAYS, Math.floor(days)))
    const keys: string[] = []
    for (let index = window - 1; index >= 0; index -= 1) keys.push(localDay(this.now() - index * 86400000))
    const merged = new Map<string, ToolDay>()
    const daily = keys.map(key => {
      let calls = 0
      let failed = 0
      for (const [tool, entry] of Object.entries(this.days[key] ?? {})) {
        calls += entry.calls
        failed += entry.failed
        const into = merged.get(tool) ?? { calls: 0, failed: 0, viaCode: 0, totalMs: 0, outputChars: 0, durations: [] }
        into.calls += entry.calls; into.failed += entry.failed; into.viaCode += entry.viaCode
        into.totalMs += entry.totalMs; into.outputChars += entry.outputChars; into.durations.push(...entry.durations)
        merged.set(tool, into)
      }
      return { day: key, calls, failed }
    })
    const tools = [...merged].map(([tool, entry]): ToolSummary => {
      const sorted = [...entry.durations].sort((a, b) => a - b)
      return { tool, calls: entry.calls, failed: entry.failed, viaCode: entry.viaCode, outputChars: entry.outputChars,
        estimatedTokens: Math.round(entry.outputChars / 4), p50Ms: percentile(sorted, 0.5), p95Ms: percentile(sorted, 0.95) }
    }).sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool))
    const outputChars = tools.reduce((sum, tool) => sum + tool.outputChars, 0)
    return { days: window, from: keys[0]!, to: keys.at(-1)!, calls: tools.reduce((sum, tool) => sum + tool.calls, 0),
      failed: tools.reduce((sum, tool) => sum + tool.failed, 0), outputChars, estimatedTokens: Math.round(outputChars / 4),
      daily, tools, ...(this.error ? { storeError: this.error } : {}) }
  }

  /** Forget every counter and remove the file's content. */
  reset(): void {
    this.days = {}
    this.dirty = true
    this.flush()
  }

  /** Write now if anything changed. Never throws. */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    if (!this.dirty) return
    this.dirty = false
    this.lastFlush = this.now()
    this.prune()
    const temp = `${this.file}.${process.pid}.tmp`
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(temp, `${JSON.stringify({ version: VERSION, days: this.days })}\n`)
      fs.renameSync(temp, this.file)
      this.error = undefined
    } catch (error) {
      this.error = `usage file not written: ${error instanceof Error ? error.message : String(error)}`
      try { fs.rmSync(temp, { force: true }) } catch {}
    }
  }

  /** Stop the pending write timer after a final flush. */
  close(): void { this.flush() }

  private schedule(): void {
    if (this.timer) return
    const wait = Math.max(0, FLUSH_MS - (this.now() - this.lastFlush))
    this.timer = setTimeout(() => { this.timer = undefined; this.flush() }, wait)
    this.timer.unref?.()
  }

  private prune(): void {
    const oldest = localDay(this.now() - (RETENTION_DAYS - 1) * 86400000)
    for (const key of Object.keys(this.days)) if (key < oldest) delete this.days[key]
  }

  private load(): void {
    let text: string
    try { text = fs.readFileSync(this.file, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.error = `usage file not read: ${(error as Error).message}`
      return
    }
    try {
      const parsed = JSON.parse(text) as { version?: unknown; days?: unknown }
      if (parsed.version !== VERSION || !parsed.days || typeof parsed.days !== 'object') throw new Error('unsupported content')
      for (const [key, tools] of Object.entries(parsed.days as Record<string, unknown>)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !tools || typeof tools !== 'object') continue
        const day: Record<string, ToolDay> = {}
        for (const [tool, entry] of Object.entries(tools as Record<string, unknown>)) {
          if (validDay(entry)) day[tool] = { ...entry, durations: entry.durations.filter(Number.isFinite).slice(-DURATION_SAMPLES) }
        }
        this.days[key] = day
      }
      this.prune()
    } catch (error) {
      // An unreadable file starts a fresh count and is replaced on the next write.
      this.error = `usage file ignored (${(error as Error).message}); counting starts over`
    }
  }
}
