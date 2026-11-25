/**
 * The sidebar console page: three tabs over the `opsSettings` remote.
 *
 * It shows only what the host answered; a failed read is stated, never replaced
 * by a guessed green status.
 */
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { ConsoleRemote, ConsoleSnapshot } from '../../settings/console-contract.js'
import { errorText } from '../forms.js'
import { zh } from './locales.js'
import type { ConsoleT } from './locales.js'
import { StatusTab } from './status.js'
import { SettingsTab } from './settings.js'
import { UsageTab } from './usage.js'

const TABS = ['status', 'settings', 'usage'] as const
type Tab = typeof TABS[number]
const TAB_LABEL = { status: 'tabStatus', settings: 'tabSettings', usage: 'tabUsage' } as const

export interface ConsoleState {
  snapshot: ConsoleSnapshot | undefined
  message: string
  at: string | undefined
  refresh(): Promise<void>
}

/** Read the console snapshot; every refresh carries an epoch so a slow answer never wins over a newer one. */
export function useConsole(api: ConsoleRemote): ConsoleState {
  const [snapshot, setSnapshot] = useState<ConsoleSnapshot>()
  const [message, setMessage] = useState(''), [at, setAt] = useState<string>()
  const epoch = useRef(0), mounted = useRef(true)
  async function refresh(): Promise<void> {
    const current = ++epoch.current
    try {
      const response = await api.console()
      if (!mounted.current || current !== epoch.current) return
      if (response.ok) { setSnapshot(response.value); setMessage(''); setAt(new Date().toLocaleTimeString()) }
      else setMessage(response.error.message)
    } catch (error) { if (mounted.current && current === epoch.current) setMessage(errorText(error)) }
  }
  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => { mounted.current = false }
  }, [api])
  return { snapshot, message, at, refresh }
}

export function ConsolePage({ api, t }: { api: ConsoleRemote; t: ConsoleT }) {
  const [tab, setTab] = useState<Tab>('status')
  const state = useConsole(api)
  const locale = t('tabStatus') === zh.tabStatus ? 'zh' : 'en'
  const tabs = useRef<Record<string, HTMLButtonElement | null>>({})
  // Arrow keys move between tabs, as the WAI-ARIA tabs pattern expects.
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (step === 0) return
    event.preventDefault()
    const next = TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length]!
    setTab(next)
    tabs.current[next]?.focus()
  }
  return <div className="ops-console">
    <header className="ops-console-head">
      <h2 className="ops-console-title">{t('title')}</h2>
      {state.snapshot && <span className="ops-console-meta">v{state.snapshot.version}</span>}
      <button type="button" className="ops-small ops-console-refresh" onClick={() => void state.refresh()}>{t('refresh')}</button>
    </header>
    <div role="tablist" aria-label={t('title')} className="ops-console-tabs" onKeyDown={onKey}>
      {TABS.map(id => <button key={id} type="button" role="tab" id={`ops-console-tab-${id}`} aria-controls={`ops-console-panel-${id}`}
        aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} className="ops-console-tab"
        ref={element => { tabs.current[id] = element }} onClick={() => setTab(id)}>{t(TAB_LABEL[id])}</button>)}
    </div>
    <section role="tabpanel" id={`ops-console-panel-${tab}`} aria-labelledby={`ops-console-tab-${tab}`} className="ops-console-panel">
      {state.message && <p role="alert" className="ops-field-error">{state.message}</p>}
      {tab === 'usage' ? <UsageTab api={api} t={t} />
        : state.snapshot === undefined ? <p role="status" className="ops-note">{state.message ? t('unavailable') : t('loading')}</p>
          : tab === 'status' ? <StatusTab snapshot={state.snapshot} at={state.at} t={t} />
            : <SettingsTab api={api} view={state.snapshot.computerUse} locale={locale} refresh={state.refresh} t={t} />}
    </section>
  </div>
}
