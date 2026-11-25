/**
 * This plugin's package identity.
 *
 * The npm name is `@huoweifang/dsh-ops-pro`; the bundle row id, the browser module
 * mount point and the CLI command keep the historical `dsh-ops-pro` spelling so
 * saved patch entries, tool habits, state directories under `<DSH_HOME>/dsh-ops/`
 * and the `ops_` tool prefix survive the rename. `LEGACY_PACKAGE_NAMES` lists the
 * unscoped names an older profile may still have installed; profile commands use
 * it to remove that copy before adding the scoped one.
 */
export const PACKAGE_NAME = '@huoweifang/dsh-ops-pro'

/** The row id the single bundle row declares, and the module id the client mounts under. */
export const ROW_ID = 'dsh-ops-pro'

/** The CLI command and state-directory spelling; it never changes with the npm name. */
export const CLI_NAME = 'dsh-ops-pro'

/** Unscoped package names earlier releases published under. */
export const LEGACY_PACKAGE_NAMES: readonly string[] = Object.freeze(['dsh-ops-pro'])
