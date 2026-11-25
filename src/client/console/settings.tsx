/** Computer-use tab: the vendored runtime's settings, saved to the console's own file. */
import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { ComputerUseView, ConsoleRemote, CuField } from '../../settings/console-contract.js'
import { errorText } from '../forms.js'
import { fieldLabel, isDirty, nextOverrides, parseField } from './model.js'
import type { ConsoleT } from './locales.js'

interface Props { api: ConsoleRemote; view: ComputerUseView; locale: string; refresh(): Promise<void>; t: ConsoleT }

function Field({ field, value, error, label, badge, onChange }: { field: CuField; value: unknown; error?: string; label: string; badge: string; onChange(value: string | boolean): void }) {
  const id = `ops-cu-${field.key}`
  const hint = <span className="ops-field-hint">{badge}{error ? ` · ${error}` : ''}</span>
  if (field.type === 'boolean') {
    return <div className="ops-field"><label className="ops-choice" htmlFor={id}>
      <input id={id} type="checkbox" checked={value === true} onChange={event => onChange(event.target.checked)} />
      <span className="ops-field-text"><span className="ops-field-label">{label}</span>{hint}</span>
    </label></div>
  }
  return <div className="ops-field">
    <label className="ops-field-label" htmlFor={id}>{label}</label>
    {field.type === 'enum'
      ? <select id={id} className="ops-input" value={String(value)} onChange={event => onChange(event.target.value)}>
        {field.values?.map(choice => <option key={choice} value={choice}>{choice}</option>)}</select>
      : <input id={id} className="ops-input" value={String(value ?? '')} aria-invalid={error ? true : undefined}
        inputMode={field.type === 'integer' ? 'numeric' : undefined} onChange={event => onChange(event.target.value)} />}
    {hint}
  </div>
}

export function SettingsTab({ api, view, locale, refresh, t }: Props) {
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  // A new host answer replaces an untouched draft; an edited one is kept.
  useEffect(() => { if (!isDirty(view, draft)) setDraft({}) }, [view])
  if (view.fields.length === 0) {
    return <div className="ops-console-stack"><p className="ops-note">{t('settingsNone')}</p>{view.problem && <p className="ops-field-error">{view.problem}</p>}</div>
  }
  const change = (field: CuField, input: string | boolean) => {
    const parsed = parseField(field, input)
    setDraft(current => ({ ...current, [field.key]: parsed.value }))
    setErrors(current => { const next = { ...current }; if (parsed.error) next[field.key] = parsed.error; else delete next[field.key]; return next })
    setMessage('')
  }
  const save = async (settings: Record<string, unknown>) => {
    setBusy(true); setMessage('')
    try {
      const response = await api.saveComputerUse(settings)
      setMessage(response.ok ? response.value.message : response.error.message)
      if (response.ok && response.value.status !== 'failed') { setDraft({}); setErrors({}) }
      await refresh()
    } catch (error) { setMessage(errorText(error)) } finally { setBusy(false) }
  }
  const valid = Object.keys(errors).length === 0
  const dirty = isDirty(view, draft)
  const submit = (event: FormEvent) => { event.preventDefault(); if (!valid) { setMessage(t('invalid')); return } void save(nextOverrides(view, draft)) }
  return <form className="ops-console-stack" onSubmit={submit}>
    <p className="ops-status-lead">{t('settingsLead')}</p>
    {view.problem && <p className="ops-field-error">{view.problem}</p>}
    <div className="ops-card ops-card-body">
      {view.fields.map(field => <Field key={field.key} field={field} value={draft[field.key] ?? view.values[field.key]} error={errors[field.key]}
        label={fieldLabel(field.label, locale)} badge={view.overrides.includes(field.key) ? t('settingsOverride') : t('settingsDefault')}
        onChange={value => change(field, value)} />)}
    </div>
    <div className="ops-settings-actions ops-console-sticky">
      <button type="submit" className="ops-settings-primary" disabled={busy || !dirty}>{t(busy ? 'saving' : 'save')}</button>
      <button type="button" className="ops-reset" disabled={busy || !dirty} onClick={() => { setDraft({}); setErrors({}); setMessage('') }}>{t('revert')}</button>
      {view.overrides.length > 0 && <button type="button" className="ops-reset" disabled={busy} onClick={() => void save({})}>{t('clear')}</button>}
    </div>
    {message && <p role="status" className="ops-note">{message}</p>}
    <p className="ops-note">{t('settingsFile')} <code>{view.file}</code></p>
  </form>
}
