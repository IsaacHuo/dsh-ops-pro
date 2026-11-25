/** Usage tab: counters of every ops_* call on this machine. */
import { useEffect, useRef, useState } from 'react'
import type { ConsoleRemote } from '../../settings/console-contract.js'
import type { UsageSummary } from '../../usage/store.js'
import { errorText } from '../forms.js'
import { compact, duration } from './model.js'
import type { ConsoleT } from './locales.js'

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="ops-console-metric"><span className="ops-console-metric-value">{value}</span><span className="ops-console-metric-label">{label}</span></div>
}

export function UsageTab({ api, t }: { api: ConsoleRemote; t: ConsoleT }) {
  const [days, setDays] = useState(7)
  const [summary, setSummary] = useState<UsageSummary>()
  const [message, setMessage] = useState(''), [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false)
  const epoch = useRef(0)
  async function load(window: number): Promise<void> {
    const current = ++epoch.current
    try {
      const response = await api.usage(window)
      if (current !== epoch.current) return
      if (response.ok) { setSummary(response.value); setMessage('') } else setMessage(response.error.message)
    } catch (error) { if (current === epoch.current) setMessage(errorText(error)) }
  }
  useEffect(() => { void load(days); return () => { epoch.current++ } }, [api, days])
  const reset = async () => {
    setBusy(true)
    try {
      const response = await api.resetUsage()
      setMessage(response.ok ? response.value.message : response.error.message)
      await load(days)
    } catch (error) { setMessage(errorText(error)) } finally { setBusy(false); setConfirming(false) }
  }
  const peak = Math.max(1, ...(summary?.daily ?? []).map(day => day.calls))
  return <div className="ops-console-stack">
    <div className="ops-console-row">
      <p className="ops-note ops-console-grow">{t('usageLead')}</p>
      <div role="group" aria-label={t('tabUsage')} className="ops-console-segment">
        {[7, 30].map(value => <button key={value} type="button" aria-pressed={days === value} className="ops-console-segment-item"
          onClick={() => setDays(value)}>{t(value === 7 ? 'days7' : 'days30')}</button>)}
      </div>
    </div>
    {message && <p role="status" className="ops-note">{message}</p>}
    {summary === undefined ? <p role="status" className="ops-note">{t('loading')}</p> : <>
      {summary.storeError && <p role="alert" className="ops-field-error">{t('storeError')}: {summary.storeError}</p>}
      <div className="ops-console-metrics">
        <Metric label={t('calls')} value={compact(summary.calls)} />
        <Metric label={t('failed')} value={compact(summary.failed)} />
        <Metric label={t('tokens')} value={`≈${compact(summary.estimatedTokens)}`} />
      </div>
      <figure className="ops-console-chart" aria-label={t('daily')}>
        <div className="ops-console-bars">
          {summary.daily.map(day => <div key={day.day} className="ops-console-bar" title={`${day.day}: ${day.calls} / ${day.failed}`}>
            <span style={{ height: `${Math.round((day.calls / peak) * 100)}%` }} /></div>)}
        </div>
        <figcaption className="ops-note">{t('daily')} · {summary.from} – {summary.to}</figcaption>
      </figure>
      {summary.tools.length === 0 ? <p className="ops-note">{t('usageEmpty')}</p>
        : <div className="ops-console-table-wrap"><table className="ops-console-table">
          <thead><tr><th scope="col">{t('tool')}</th><th scope="col">{t('calls')}</th><th scope="col">{t('failed')}</th>
            <th scope="col">{t('viaCode')}</th><th scope="col">{t('p50')}</th><th scope="col">{t('p95')}</th><th scope="col">{t('tokens')}</th></tr></thead>
          <tbody>{summary.tools.map(tool => <tr key={tool.tool}><th scope="row"><code>{tool.tool}</code></th><td>{tool.calls}</td><td>{tool.failed}</td>
            <td>{tool.viaCode}</td><td>{duration(tool.p50Ms)}</td><td>{duration(tool.p95Ms)}</td><td>≈{compact(tool.estimatedTokens)}</td></tr>)}</tbody>
        </table></div>}
    </>}
    <div className="ops-settings-actions">
      {confirming
        ? <><span className="ops-note" role="alert">{t('resetConfirm')}</span>
          <button type="button" className="ops-small" disabled={busy} onClick={() => void reset()}>{t('confirm')}</button>
          <button type="button" className="ops-reset" disabled={busy} onClick={() => setConfirming(false)}>{t('cancel')}</button></>
        : <button type="button" className="ops-reset" onClick={() => setConfirming(true)}>{t('reset')}</button>}
    </div>
  </div>
}
