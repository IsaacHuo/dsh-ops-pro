/**
 * Host-side approval for published computer-use tools.
 *
 * The vendored runtime decides which operations need the user's approval
 * (`classifyOperation`) and refuses any risky call that does not carry a grant
 * minted by its host (`consumeGrant` in the server). The upstream adapter wires
 * that to `mcp__*__windows_computer_use_*` names; this module wires the same
 * vendored functions to the `ops_cu_*` names, translating each name back to the
 * server's before classifying or minting, so the decision rules stay upstream's
 * byte for byte.
 *
 * @module dsh-ops/cu/approval
 */
import type { Context } from '../adapter/dsh/types.js'
import { upstreamCuName } from './names.js'

/** The vendored policy functions this module calls. */
export interface VendorPolicy {
  parseArguments(value: unknown): Record<string, unknown>
  classifyOperation(name: string, args: Record<string, unknown>, env: Record<string, string | undefined>, locale: string): { kind: string }
  mintGrant(name: string, args: Record<string, unknown>, secret: string): string
  sessionSkipsApproval(ctx: Context, exec: unknown): boolean
}

/** Per-row inputs of the classifier. */
export interface ApprovalRuntime {
  readonly secret: string
  env(): Record<string, string | undefined>
  locale(): string
}

interface Exec { name?: unknown; arguments?: unknown }

/** Key-sorted JSON, so an argument object reordered between hooks still compares equal. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * Install the approval hooks for `ops_cu_*` calls.
 * @param ctx - the row's context; the hooks are torn down with it.
 * @param policy - the vendored policy module.
 * @param runtime - the row's approval secret and classifier inputs.
 */
export function installApproval(ctx: Context, policy: VendorPolicy, runtime: ApprovalRuntime): void {
  const gated = new WeakMap<object, string>()
  const on = ctx.on as unknown as (name: string, listener: (exec: Exec, next: () => Promise<{ kind: string }>) => unknown, options?: { global?: boolean }) => () => void
  on.call(ctx, 'tools/pre-execute', async (exec, next) => {
    const upstream = typeof exec?.name === 'string' ? upstreamCuName(exec.name) : undefined
    if (!upstream) return next()
    const args = policy.parseArguments(exec.arguments)
    if (Object.hasOwn(args, '_wcuApproval')) {
      return { kind: 'deny', reason: 'WCU_POLICY_DENIED: approval credentials cannot be supplied by a tool caller.' }
    }
    const decision = policy.classifyOperation(upstream, args, runtime.env(), runtime.locale())
    if (decision.kind === 'deny') return decision
    if (decision.kind === 'ask') gated.set(exec as object, canonicalJson(args))
    const downstream = await next()
    if (decision.kind !== 'ask' || downstream.kind !== 'allow') return downstream
    return policy.sessionSkipsApproval(ctx, exec) ? downstream : decision
  }, { global: true })
  on.call(ctx, 'tools/execute', async (exec, next) => {
    const approved = gated.get(exec as object)
    if (approved === undefined) return next()
    gated.delete(exec as object)
    const previous = exec.arguments
    const args = policy.parseArguments(previous)
    // The grant binds the exact approved arguments; anything rewritten since is not what the user saw.
    if (canonicalJson(args) !== approved) throw new Error('WCU_APPROVAL_REQUIRED: arguments changed after the approval request.')
    exec.arguments = { ...args, _wcuApproval: policy.mintGrant(upstreamCuName(String(exec.name))!, args, runtime.secret) }
    try { return await next() } finally { exec.arguments = previous }
  }, { global: true })
}
