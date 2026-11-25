/**
 * `dsh-ops/computer-use` row: Windows desktop and browser automation as `ops_cu_*`.
 *
 * WHY THIS IS A ROW AND NOT PART OF A MODE
 *
 * Computer use is a capability, not a projection of the file/shell kernel, so it
 * is mounted beside the modes (like the download guard) and its tools are
 * registered globally: every session sees them, whichever mode or custom preset
 * it runs, Native or PTC. Modes only ever `restrict({ deny })` the official
 * names they replace, so a global `ops_cu_*` is never masked by a mode.
 *
 * WHAT RUNS WHERE
 *
 * The vendored dsh-computer-use-win server (`lib/computer-use/`, byte-identical
 * to upstream) runs as one persistent child of the host, exactly as the upstream
 * adapter starts it (`process.execPath` with `ELECTRON_RUN_AS_NODE=1`). This row
 * replaces the upstream adapter's MCP bridge with a minimal stdio client and
 * reuses the vendored approval rules unchanged (`../../cu/approval.ts`).
 *
 * @module dsh-ops/components/computer-use
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context, ToolDefinition } from '../../adapter/dsh/types.js'
import { installApproval, type VendorPolicy } from '../../cu/approval.js'
import { resolveComputerUseConfig, type ComputerUseConfig } from '../../cu/config.js'
import { isStandaloneCuName, publicCuName, upstreamCuName } from '../../cu/names.js'
import { RpcFailure } from '../../cu/rpc-client.js'
import { ComputerUseServer, type ServerCallResult, type ServerTool } from '../../cu/server.js'
import { publishComputerUseRestart, publishComputerUseStatus, type ComputerUseStatus } from '../../cu/state.js'
import { readOverrides } from '../../cu/overrides.js'

export const name = 'dsh-ops-computer-use'

/**
 * Where `npm run build` assembles the vendored runtime. `DSH_OPS_CU_RUNTIME`
 * points a diagnosis (or a suite) at another assembled copy.
 */
export const RUNTIME_DIR = process.env.DSH_OPS_CU_RUNTIME || fileURLToPath(new URL('../../computer-use/', import.meta.url))

interface VendorSettings {
  normalizeSettings(input: Record<string, unknown>): Record<string, unknown> & { mode?: string }
  enabledToolsForSettings(input: Record<string, unknown>): string[]
}

interface Tools { register(definition: ToolDefinition): () => void; definitions?(): readonly { name: string }[] }

/** The canonical value of every `ops_cu_*` call. */
export type CuOutcome =
  | { status: 'completed'; text: string }
  | { status: 'failed'; text: string; error: { code: string; message: string; effectState: 'none' | 'unknown' } }

function packageVersion(): string {
  try { return String(JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version) } catch { return '0.0.0' }
}

function text(result: ServerCallResult): string {
  return (result.content ?? []).filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n')
}

/** Translate a call result into the returned outcome; failures are values, never throws. */
export function outcomeOf(result: ServerCallResult): CuOutcome {
  const body = text(result)
  if (!result.isError) return { status: 'completed', text: body }
  // The action may have started before the server reported the error.
  return { status: 'failed', text: body, error: { code: 'CU_TOOL_ERROR', message: body.split('\n')[0] || 'computer-use call failed', effectState: 'unknown' } }
}

/** Translate a transport failure; `started` says whether the request reached the server. */
export function failureOf(error: unknown, started: boolean): CuOutcome {
  const code = error instanceof RpcFailure ? (error.code === 'RPC_TIMEOUT' ? 'CU_TIMEOUT' : error.code === 'RPC_CANCELLED' ? 'CU_CANCELLED' : 'CU_UNAVAILABLE') : 'CU_UNAVAILABLE'
  const message = error instanceof Error ? error.message : String(error)
  return { status: 'failed', text: message, error: { code, message, effectState: started ? 'unknown' : 'none' } }
}

/** One server tool as this plugin publishes it. */
export function toolDefinition(tool: ServerTool, server: Pick<ComputerUseServer, 'ready' | 'call'>, config: ComputerUseConfig): ToolDefinition | undefined {
  const published = publicCuName(tool.name)
  if (!published) return undefined
  return {
    name: published,
    description: tool.description ?? '',
    parameters: (tool.inputSchema ?? { type: 'object', properties: {} }) as ToolDefinition['parameters'],
    timeoutMs: config.callTimeoutMs + 5000,
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: (value as CuOutcome).text || ((value as CuOutcome).status === 'completed' ? 'done' : 'failed') }] },
    execute: async (args, exec) => {
      try { await server.ready() } catch (error) { return failureOf(error, false) }
      try {
        const result = await server.call(upstreamCuName(published)!, (args ?? {}) as Record<string, unknown>, { timeoutMs: config.callTimeoutMs, signal: exec.signal })
        return outcomeOf(result)
      } catch (error) { return failureOf(error, true) }
    },
  } as ToolDefinition
}

/**
 * Mount the row.
 * @param ctx - the row's cordis context.
 * @param rawConfig - the section's own keys (`settings`, `callTimeoutMs`).
 */
export function apply(ctx: Context, rawConfig?: unknown): void {
  const config = resolveComputerUseConfig(rawConfig)
  let status: ComputerUseStatus = { state: 'starting', tools: [], conflict: false, backendMissing: false }
  let tools: Tools | undefined
  let server: ComputerUseServer | undefined
  const read = (): ComputerUseStatus => ({
    ...status,
    conflict: tools?.definitions?.().some(definition => isStandaloneCuName(definition.name)) ?? false,
    ...(server ? { server: server.snapshot() } : {}),
  })
  ctx.effect(() => publishComputerUseStatus(read), 'dsh-ops: computer-use status')
  if (process.platform !== 'win32') {
    status = { ...status, state: 'unsupported', message: 'computer use drives Windows UI Automation and is available on Windows only' }
    return
  }
  const serverPath = path.join(RUNTIME_DIR, 'mcp', 'server.mjs')
  if (!existsSync(serverPath)) {
    status = { ...status, state: 'failed', message: `the computer-use runtime is not built (${serverPath}); run npm run build` }
    return
  }
  const backendMissing = !existsSync(path.join(RUNTIME_DIR, 'scripts', 'windows-uia.ps1'))
  // The runtime lives in its own child scope so the console can restart it with
  // freshly saved settings without remounting the whole row.
  let fork: { dispose(): unknown } | undefined
  const mountRuntime = (): void => {
    const overrides = readOverrides()
    status = { state: 'starting', tools: [], conflict: false, backendMissing, ...(overrides.error ? { message: overrides.error } : {}) }
    tools = undefined
    server = undefined
    const effective: ComputerUseConfig = { ...config, settings: { ...config.settings, ...overrides.settings } }
    fork = ctx.plugin({ name: 'dsh-ops/computer-use-runtime', apply: (inner: Context) => {
      void startRow(inner, effective, serverPath, next => { status = { ...status, ...next } }, value => { tools = value }, value => { server = value })
    } }) as unknown as { dispose(): unknown }
  }
  mountRuntime()
  ctx.effect(() => publishComputerUseRestart(async () => {
    await fork?.dispose()
    mountRuntime()
  }), 'dsh-ops: computer-use restart')
}

async function startRow(ctx: Context, config: ComputerUseConfig, serverPath: string, update: (next: Partial<ComputerUseStatus>) => void,
  setTools: (tools: Tools) => void, setServer: (server: ComputerUseServer) => void): Promise<void> {
  let vendor: { settings: VendorSettings; policy: VendorPolicy; locale: () => string }
  let settings: Record<string, unknown> & { mode?: string }
  try {
    const vendored = (file: string): Promise<unknown> => import(pathToFileURL(path.join(RUNTIME_DIR, 'mcp', file)).href)
    const [settingsModule, policyModule, strings] = await Promise.all([vendored('settings.mjs'), vendored('policy.mjs'), vendored('overlay-strings.mjs')])
    vendor = { settings: settingsModule as VendorSettings, policy: policyModule as VendorPolicy, locale: () => String((strings as { systemLocale(): string }).systemLocale()) }
    settings = vendor.settings.normalizeSettings({ ...config.settings })
  } catch (error) {
    update({ state: 'failed', message: `computer-use settings or runtime rejected: ${error instanceof Error ? error.message : String(error)}` })
    return
  }
  // Control files of this row: one private directory per host process, removed on teardown.
  const control = mkdtempSync(path.join(os.tmpdir(), `dsh-ops-cu-${process.pid}-`))
  const secret = randomBytes(32).toString('base64url')
  const files = { ledger: path.join(control, 'approval-grants.json'), ports: path.join(control, 'host-ports.json'), tabs: path.join(control, 'user-tabs.json') }
  const hostPorts = (): string[] => {
    const port = (ctx.get as (name: string) => { port?: unknown } | undefined)('webServer')?.port
    return typeof port === 'number' && port > 0 ? [String(port)] : []
  }
  writeFileSync(files.ports, JSON.stringify({ ports: hostPorts() }))
  ctx.effect(() => () => { setTimeout(() => { try { rmSync(control, { recursive: true, force: true }) } catch {} }, 1500).unref() }, 'dsh-ops: computer-use control directory')
  const env = (): Record<string, string | undefined> => ({ WCU_HOST_PORTS: hostPorts().join('|'), WCU_HOST_PORT_FILE: files.ports, WCU_USER_TABS_FILE: files.tabs, WCU_LOCALE: vendor.locale() })
  installApproval(ctx, vendor.policy, { secret, env, locale: vendor.locale })
  const enabled = vendor.settings.enabledToolsForSettings(settings)
  const server = new ComputerUseServer(() => ({
    command: process.execPath, args: [serverPath], cwd: RUNTIME_DIR,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', WCU_IMAGE_MODE: 'file',
      // DSH's own discovery handles lazy publication; the server always lists its selection.
      WCU_TOOL_MODE: settings.mode === 'lite' ? 'lite' : 'full', WCU_ENABLED_TOOLS: JSON.stringify(enabled), WCU_SETTINGS_JSON: JSON.stringify(settings),
      WCU_APPROVAL_SECRET: secret, WCU_APPROVAL_LEDGER: files.ledger, WCU_HOST_PID: String(process.pid), WCU_HOST_EXECUTABLE: process.execPath, ...env() },
  }), packageVersion())
  setServer(server)
  ctx.effect(() => () => { void server.dispose() }, 'dsh-ops: computer-use server')
  ctx.inject(['tools'], async scoped => {
    const registry = (scoped as unknown as { tools: Tools }).tools
    setTools(registry)
    let listed: ServerTool[]
    try { listed = await server.listTools() } catch (error) {
      update({ state: 'failed', message: `computer-use server did not start: ${error instanceof Error ? error.message : String(error)}` })
      return
    }
    const published: string[] = []
    for (const tool of listed) {
      const definition = toolDefinition(tool, server, config)
      if (!definition) continue
      const dispose = registry.register(definition)
      scoped.effect(() => dispose, `dsh-ops: ${definition.name}`)
      published.push(definition.name)
    }
    update({ state: 'ready', tools: published.sort() })
    if (registry.definitions?.().some(definition => isStandaloneCuName(definition.name))) {
      console.warn('dsh-ops: a standalone dsh-computer-use-win install publishes the same runtime as mcp__*__windows_computer_use_*; disable one of them to avoid duplicate desktop control')
    }
  })
}
