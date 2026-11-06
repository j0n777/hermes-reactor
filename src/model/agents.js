// Agents panel model: normalise `session.foreign.list` rows, keep the list state, filter,
// and build the view model. Titles, folders and excerpts are untrusted text.

import { capLength, cleanText, folderName } from './sanitize.js'

export const RECENT_ACTIVITY_MS = 2 * 60 * 1000
export const PAGE_LIMIT = 50
export const REF_PATTERN = /^[A-Za-z0-9_-]{8,128}$/

const SOURCES = ['claude', 'codex']

export function agentsInitial() {
  return { status: 'loading', rows: [], error: '', updatedAt: 0, unreadable: 0, truncated: false }
}

function toMs(mtime) {
  const n = Number(mtime)
  if (!Number.isFinite(n) || n <= 0) return 0
  // Seconds from the backend; tolerate milliseconds.
  return n > 1e11 ? Math.round(n) : Math.round(n * 1000)
}

/** Normalise one backend row. Returns null for a row that cannot be shown safely. */
export function normalizeRow(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (!REF_PATTERN.test(id)) return null
  const source = typeof raw.source === 'string' ? raw.source.toLowerCase() : ''
  if (!SOURCES.includes(source)) return null
  const turns = Number(raw.turn_count)
  return {
    id,
    source,
    title: cleanText(raw.title ?? '', 140),
    folder: folderName(raw.cwd ?? ''),
    folderPath: cleanText(raw.cwd ?? '', 240),
    mtimeMs: toMs(raw.mtime),
    turns: Number.isFinite(turns) && turns >= 0 ? Math.floor(turns) : 0
  }
}

/** Normalise a `session.foreign.list` result. Returns null when the shape is wrong. */
export function normalizeList(result) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.sessions)) return null
  const rows = result.sessions.map(normalizeRow).filter(Boolean)
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : 1))
  const unreadable = Number(result.unreadable)
  return {
    rows,
    unreadable: Number.isFinite(unreadable) && unreadable > 0 ? Math.floor(unreadable) : 0,
    truncated: result.next_offset !== null && result.next_offset !== undefined
  }
}

export function agentsReduce(state, action) {
  switch (action.type) {
    case 'agents.start':
      // Keep showing the old rows while refreshing; only the first load shows "loading".
      return state.status === 'ready' || state.status === 'empty' ? state : { ...state, status: 'loading', error: '' }
    case 'agents.ok': {
      const { rows, unreadable, truncated } = action.list
      return { status: rows.length ? 'ready' : 'empty', rows, error: '', updatedAt: action.at, unreadable, truncated }
    }
    case 'agents.fail':
      return { ...state, status: 'error', error: cleanText(action.message ?? '', 160), updatedAt: state.updatedAt }
    default:
      return state
  }
}

/** Filtered rows for display. */
export function filterRows(rows, { source = 'all', query = '' } = {}) {
  const q = cleanText(query, 80).toLowerCase()
  return rows.filter(row => {
    if (source !== 'all' && row.source !== source) return false
    if (!q) return true
    return `${row.title} ${row.folder} ${row.folderPath}`.toLowerCase().includes(q)
  })
}

/** Changed very recently: another app may still be driving it (the same 2 minute rule as the tool). */
export function isMaybeActive(row, now) {
  return row.mtimeMs > 0 && now - row.mtimeMs >= 0 && now - row.mtimeMs < RECENT_ACTIVITY_MS
}

/** "now", "5m", "3h", "2d" in the user's language. */
export function formatAge(mtimeMs, now, t) {
  if (!mtimeMs) return ''
  const sec = Math.max(0, Math.floor((now - mtimeMs) / 1000))
  if (sec < 10) return t('age.now')
  if (sec < 60) return t('age.s', { n: sec })
  const min = Math.floor(sec / 60)
  if (min < 60) return t('age.m', { n: min })
  const hours = Math.floor(min / 60)
  if (hours < 48) return t('age.h', { n: hours })
  return t('age.d', { n: Math.floor(hours / 24) })
}

export function sourceLabel(source, t) {
  return source === 'codex' ? t('agents.sourceCodex') : t('agents.sourceClaude')
}

export function turnsLabel(n, t) {
  return n === 1 ? t('agents.turnsOne') : t('agents.turns', { n })
}

/** The prompt put in the chat draft when the user clicks a row. Untrusted fields are cleaned and capped. */
export function briefPrompt(row, t) {
  const title = cleanText(row.title || t('agents.untitled'), 80).replace(/["\u201C\u201D]/g, "'")
  const folder = row.folder || t('agents.noFolder')
  return t('agents.briefPrompt', { agent: sourceLabel(row.source, t), title, folder })
}

/** A `ref` from a model-written directive. Untrusted: must look like an opaque handle. */
export function isValidRef(ref) {
  return typeof ref === 'string' && REF_PATTERN.test(ref)
}

/** Find a row by exact id, or by an unambiguous prefix of at least 12 characters. */
export function matchRef(ref, rows) {
  if (!isValidRef(ref)) return null
  const exact = rows.find(r => r.id === ref)
  if (exact) return exact
  if (ref.length < 12) return null
  const prefixed = rows.filter(r => r.id.startsWith(ref))
  return prefixed.length === 1 ? prefixed[0] : null
}

/** Display model for one row. */
export function rowView(row, now, t) {
  return {
    id: row.id,
    source: row.source,
    agent: sourceLabel(row.source, t),
    title: capLength(row.title || t('agents.untitled'), 120),
    folder: row.folder || t('agents.noFolder'),
    folderPath: row.folderPath,
    age: formatAge(row.mtimeMs, now, t),
    turns: turnsLabel(row.turns, t),
    maybeActive: isMaybeActive(row, now)
  }
}

/**
 * What the panel should render.
 * @returns {{ kind: 'disconnected' | 'loading' | 'error' | 'empty' | 'emptyFiltered' | 'list', rows: object[], staleError?: boolean }}
 */
export function panelKind(state, gateway, filter, now, t) {
  if (gateway !== 'open') return { kind: 'disconnected', rows: [] }
  if (state.status === 'loading' && state.rows.length === 0) return { kind: 'loading', rows: [] }
  if (state.status === 'error' && state.rows.length === 0) return { kind: 'error', rows: [] }
  if (state.rows.length === 0) return { kind: 'empty', rows: [] }
  const shown = filterRows(state.rows, filter).map(r => rowView(r, now, t))
  if (shown.length === 0) return { kind: 'emptyFiltered', rows: [], staleError: state.status === 'error' }
  return { kind: 'list', rows: shown, staleError: state.status === 'error' }
}
