/**
 * Pure helpers of the sidebar console, kept apart from React so a suite can
 * assert them directly.
 */
import type { ComputerUseView, CuField } from '../../settings/console-contract.js'

/** The half of an upstream `中文 / English` label that matches the page locale. */
export function fieldLabel(label: string, locale: string): string {
  const parts = label.split(' / ')
  if (parts.length < 2) return label
  return locale.toLowerCase().startsWith('zh') ? parts[0]! : parts.slice(1).join(' / ')
}

/** Parse one input's text into the field's type; `error` names what is wrong. */
export function parseField(field: CuField, input: string | boolean): { value: unknown; error?: string } {
  switch (field.type) {
    case 'boolean': return { value: input === true || input === 'true' }
    case 'enum': return field.values?.includes(String(input)) ? { value: String(input) } : { value: input, error: `one of ${field.values?.join(', ')}` }
    case 'integer': {
      const text = String(input).trim()
      const value = /^-?\d+$/.test(text) ? Number(text) : NaN
      if (!Number.isSafeInteger(value)) return { value: input, error: 'an integer' }
      if ((field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) return { value, error: `${field.min}–${field.max}` }
      return { value }
    }
    default: {
      const value = String(input)
      if (field.maxLength !== undefined && value.length > field.maxLength) return { value, error: `≤ ${field.maxLength}` }
      if (/[\r\n]/.test(value)) return { value, error: 'one line' }
      return { value }
    }
  }
}

/**
 * The overrides to save: every key the console file already sets (with its draft
 * value) plus every key whose draft differs from the effective value.
 */
export function nextOverrides(view: ComputerUseView, draft: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of view.fields) {
    const value = draft[field.key] ?? view.values[field.key]
    if (view.overrides.includes(field.key) || value !== view.values[field.key]) out[field.key] = value
  }
  return out
}

/** Whether the draft differs from what the host reported. */
export function isDirty(view: ComputerUseView, draft: Record<string, unknown>): boolean {
  return view.fields.some(field => field.key in draft && draft[field.key] !== view.values[field.key])
}

/** Compact count: 1234 → 1.2k, 2_500_000 → 2.5M. */
export function compact(value: number): string {
  if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(value >= 1e4 ? 0 : 1)}k`
  return String(value)
}

/** Milliseconds as a short duration. */
export function duration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)} s` : `${Math.round(ms)} ms`
}
