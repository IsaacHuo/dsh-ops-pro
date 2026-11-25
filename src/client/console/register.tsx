/**
 * Mount the sidebar console: one `sidebar.panellist` entry and the `main` page
 * under the same id, the pattern the host's own panels use.
 */
import type { Context } from '../../adapter/dsh/types.js'
import type { ConsoleRemote } from '../../settings/console-contract.js'
import { ConsolePage } from './page.js'
import { CONSOLE_CSS } from './styles.js'
import { en, NS, zh } from './locales.js'
import type { ConsoleT } from './locales.js'

export const CONSOLE_ID = 'dsh-ops-pro'

/** A 16px gauge, stroke in currentColor like the host's panel icons. */
export function ConsoleIcon({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
    <path d="M2.5 11.5a5.5 5.5 0 1 1 11 0" /><path d="M8 11.5 10.6 7" /><circle cx="8" cy="11.5" r="0.9" fill="currentColor" stroke="none" />
  </svg>
}

export function mountConsole(ctx: Context, api: ConsoleRemote): void {
  const slots = (ctx as unknown as { slots: { inject(name: string, body: () => unknown): unknown; register(meta: Record<string, unknown>, view: unknown): unknown } }).slots
  const locale = (ctx as unknown as { locale: { register(ns: string, dicts: unknown): () => void; bind?(ns: string): ConsoleT } }).locale
  ctx.effect(() => locale.register(NS, { en, zh }), 'dsh-ops: console dictionaries')
  // A locale service without `bind` (older hosts, embedding suites) must not take
  // the row page down with it: the console then speaks English.
  const t: ConsoleT = typeof locale.bind === 'function' ? locale.bind(NS)
    : ((key: keyof typeof en) => en[key] ?? key) as unknown as ConsoleT
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.dshOpsConsole = 'true'; style.textContent = CONSOLE_CSS; document.head.append(style)
    return () => style.remove()
  }, 'dsh-ops: console styles')
  function Page(props: { t?: ConsoleT }) { return <ConsolePage api={api} t={props.t ?? t} /> }
  slots.inject('main', () => slots.register({ name: 'main', key: CONSOLE_ID, locale: NS }, Page))
  slots.inject('sidebar.panellist', () => slots.register({ name: 'sidebar.panellist', id: CONSOLE_ID, order: 20, label: () => t('panel'), locale: NS }, ConsoleIcon))
}
