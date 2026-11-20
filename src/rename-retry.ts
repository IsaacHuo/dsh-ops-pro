import fs from 'node:fs'

/** How long a directory rename keeps being retried, and how long to wait between attempts.
 *  Cumulative budget is 2.5 s, deliberately above the window measured in #352: on Windows 11 26100
 *  the same rename that raises `EPERM` at +2 ms was observed to succeed only at +1639 ms,
 *  including from another process, with real-time antivirus off. A first 1.5 s budget covered the
 *  typical ~1.5 s recovery but sat just below that worst sample; the extra 1 s step covers it
 *  without waiting forever. Only sharing/ownership errors are retried — a permission that will
 *  never change still surfaces after the last delay. */
export const RENAME_RETRY_DELAYS_MS: readonly number[] = [100, 200, 400, 800, 1000]
const RETRYABLE_RENAME_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES'])
/** A blocking sleep, so the retry does not turn a synchronous caller asynchronous. */
const sleepSync = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

/** Rename a freshly written directory, tolerating the brief window in which Windows still holds
 *  the new tree (#352). Use it only for publication renames that install a verified tree; cleanup
 *  renames keep their no-retry contract and leave a busy entry for the next run.
 *
 *  `rename` and `wait` are injectable so a test can make the failure deterministic and assert the
 *  bound instead of sleeping on a real 2.5 s window. */
export function renameWithRetry(from: string, to: string, {
  rename = (source: string, destination: string): void => { fs.renameSync(source, destination) },
  delays = RENAME_RETRY_DELAYS_MS,
  wait = sleepSync,
}: { rename?: (from: string, to: string) => void; delays?: readonly number[]; wait?: (ms: number) => void } = {}): void {
  for (let attempt = 0; ; attempt += 1) {
    try { rename(from, to); return } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= delays.length || code === undefined || !RETRYABLE_RENAME_CODES.has(code)) throw error
      wait(delays[attempt])
    }
  }
}
