/** The symbol newer cordis builds key the composition root under. */
export const CORDIS_ROOT: unique symbol = Symbol.for('cordis.root') as never

/**
 * The composition root of a cordis context, whichever cordis spelling the host ships.
 *
 * Released cordis 4.1 exposes the root as `ctx.root`; later cordis builds dropped
 * that property for `Symbol.for('cordis.root')`, and a bare `ctx.root` read then
 * falls through to service resolution and throws
 * `cannot get property "root" without inject` (#1026). The symbol is read first
 * because a symbol key never reaches service resolution; `'root' in ctx` is a
 * `has` check, which the cordis proxy does not trap, so it cannot throw either.
 * @param ctx - any cordis context, or a plain object standing in for one.
 * @returns the root context, or `ctx` itself when it carries neither spelling.
 */
export function hostRoot<T extends object>(ctx: T): T {
  const marked = (ctx as { [CORDIS_ROOT]?: unknown })[CORDIS_ROOT]
  if (typeof marked === 'object' && marked !== null) return marked as T
  if ('root' in ctx) {
    const legacy = (ctx as { root?: unknown }).root
    if (typeof legacy === 'object' && legacy !== null) return legacy as T
  }
  return ctx
}
