// Continue-session proposals: the model and the controller behind the big "click to run" card.
//
// The Python tool registers a proposal in server memory; this side lists it through `ctx.rest`
// (`/api/plugins/hermes-reactor/proposals`), shows it, and releases it only on a real click. Pure: all I/O is
// injected, so every rule is testable.
//
// Rules (docs/DESIGN.md):
//  - Run needs a real, trusted click: `isTrusted`, a `click` event and `detail > 0`. Enter or Space on a
//    focused button reports `detail` 0, and a script-made event is not trusted, so neither can run anything.
//  - Deny holds the focus and is the easy answer; any trusted gesture may deny.
//  - One request per proposal at a time and one Run per proposal: a double click sends once.
//  - Everything from outside (titles, folders, the instruction, the agent's output) is untrusted text:
//    cleaned, capped and rendered as text only. The output is never put into the chat or sent to a model.

import { isRealClick, isTrustedGesture } from './approval.js'
import { cleanBlock, cleanText, cleanWhole } from './sanitize.js'

export const ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/
export const STATES = Object.freeze(['pending', 'running', 'finished', 'failed', 'cancelled', 'denied', 'expired'])
export const TERMINAL = Object.freeze(['finished', 'failed', 'cancelled', 'denied', 'expired'])
export const AGENTS = Object.freeze(['claude', 'codex'])
// The card shows the WHOLE instruction or it does not offer Run. These are the limits the backend enforces (it refuses
// anything over them with `instruction_too_long`): INSTRUCTION_MAX / INSTRUCTION_MAX_LINES in reactor_hermes/continuation.py.
export const INSTRUCTION_MAX_CHARS = 4000
export const INSTRUCTION_MAX_LINES = 40
export const OUTPUT_SHOWN_CHARS = 8000

export function proposalsInitial() {
  return { status: 'loading', items: [], error: '', updatedAt: 0 }
}

/**
 * Whether the instruction can be drawn exactly as it will be sent. The text is drawn as received, character for
 * character (no clipping, no trimming of lines). It does not fit when it is over the limits or when cleaning it would
 * change it (hidden characters): then only a clean excerpt is shown, with the number of characters not shown, and Run
 * is off. The card never silently truncates.
 * @returns {{ fits: boolean, shown: string, hidden: number }}
 */
export function instructionCheck(raw) {
  const text = typeof raw === 'string' ? raw : ''
  const clean = cleanWhole(text)
  const chars = Array.from(text)
  const fits = clean === text && chars.length <= INSTRUCTION_MAX_CHARS && (text ? text.split('\n').length : 0) <= INSTRUCTION_MAX_LINES
  if (fits) return { fits: true, shown: text, hidden: 0 }
  const excerpt = Array.from(clean.split('\n').slice(0, INSTRUCTION_MAX_LINES).join('\n')).slice(0, INSTRUCTION_MAX_CHARS).join('')
  return { fits: false, shown: excerpt, hidden: Math.max(1, chars.length - Array.from(excerpt).length) }
}

/** One backend proposal to a safe item. Null when it cannot be shown or answered safely. */
export function normalizeProposal(raw, receivedAt = 0) {
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) return null
  const agent = typeof raw.agent === 'string' ? raw.agent.toLowerCase() : ''
  if (!AGENTS.includes(agent)) return null
  const state = typeof raw.state === 'string' ? raw.state : ''
  if (!STATES.includes(state)) return null
  const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null)
  const remaining = num(raw.remaining_s)
  const instruction = instructionCheck(raw.instruction)
  const hooks = Array.isArray(raw.project_hooks) ? raw.project_hooks.map(n => cleanText(n, 60)).filter(Boolean).slice(0, 4) : []
  return {
    id: raw.id,
    label: cleanText(raw.label ?? '', 16),
    agent,
    title: cleanText(raw.title ?? '', 120),
    folder: cleanText(raw.folder ?? '', 240),
    instruction: instruction.shown,
    instructionFits: instruction.fits,
    instructionHidden: instruction.hidden,
    projectHooks: hooks,
    state,
    code: /^[a-z_]{1,40}$/.test(raw.code ?? '') ? raw.code : '',
    started: raw.started === true,
    remainingS: remaining === null ? 0 : Math.max(0, Math.floor(remaining)),
    receivedAt,
    startedAt: num(raw.started_at),
    endedAt: num(raw.ended_at),
    exitCode: num(raw.exit_code),
    output: cleanBlock(raw.output ?? '', OUTPUT_SHOWN_CHARS, 200),
    outputTruncated: raw.output_truncated === true,
    sending: '',
    failure: ''
  }
}

/** Normalise the list reply. Null when the shape is wrong. */
export function normalizeProposalList(result, receivedAt = 0) {
  if (!result || typeof result !== 'object' || result.ok !== true || !Array.isArray(result.proposals)) return null
  return result.proposals.map(p => normalizeProposal(p, receivedAt)).filter(Boolean)
}

/** Seconds left to click, counted from when the reply arrived (never from the server clock). */
export function secondsLeft(item, now) {
  if (item.state !== 'pending') return 0
  return Math.max(0, item.remainingS - Math.floor((now - item.receivedAt) / 1000))
}

/** A pending proposal whose time ran out locally is shown as expired and cannot be run. */
export function effectiveState(item, now) {
  return item.state === 'pending' && secondsLeft(item, now) <= 0 ? 'expired' : item.state
}

export function proposalsReduce(state, action) {
  switch (action.type) {
    case 'proposals.ok': {
      // Keep what the user is in the middle of ('sending') when the same proposal comes back.
      const sending = new Map(state.items.filter(i => i.sending).map(i => [i.id, i.sending]))
      const items = action.items.map(i => (sending.has(i.id) && i.state === 'pending' ? { ...i, sending: sending.get(i.id) } : i))
      return { status: items.length ? 'ready' : 'empty', items, error: '', updatedAt: action.at }
    }
    case 'proposals.fail':
      return { ...state, status: action.unavailable ? 'unavailable' : 'error', error: cleanText(action.message ?? '', 160) }
    case 'proposal.sending':
      return { ...state, items: state.items.map(i => (i.id === action.id ? { ...i, sending: action.kind, failure: '' } : i)) }
    case 'proposal.update': {
      const incoming = action.item
      const known = state.items.some(i => i.id === incoming.id)
      const items = known ? state.items.map(i => (i.id === incoming.id ? incoming : i)) : [...state.items, incoming]
      return { ...state, status: 'ready', items, error: '' }
    }
    case 'proposal.sendFailed':
      return { ...state, items: state.items.map(i => (i.id === action.id ? { ...i, sending: '', failure: cleanText(action.reason ?? '', 160) } : i)) }
    default:
      return state
  }
}

export const MAX_PENDING = 5 // the backend refuses a sixth pending proposal (reactor_hermes/proposals.py MAX_PENDING)

/** Which cards to draw: every one waiting or running first, then the newest finished ones up to `max`. */
export function visibleItems(items, now, max = MAX_PENDING) {
  const live = state => state === 'pending' || state === 'running'
  const active = items.filter(i => live(effectiveState(i, now)))
  const rest = items.filter(i => !live(effectiveState(i, now)))
  const room = Math.max(0, max - active.length)
  return [...active, ...(room > 0 ? rest.slice(-room) : [])]
}

/** How many cards need a click: shown as a badge. */
export function waitingCount(state, now) {
  return state.items.filter(i => effectiveState(i, now) === 'pending').length
}

/**
 * The buttons a card offers, in display order. Deny first (it holds the focus). Run only while the proposal is
 * pending, not expired and nothing is being sent. A running proposal offers Stop instead.
 * @returns {{ kind: 'deny' | 'run' | 'stop', primary: boolean, disabled: boolean }[]}
 */
export function buttonsFor(item, now) {
  const state = effectiveState(item, now)
  const busy = Boolean(item.sending)
  if (state === 'pending') {
    return [
      { kind: 'deny', primary: true, disabled: busy },
      { kind: 'run', primary: false, disabled: busy || !item.instructionFits }
    ]
  }
  if (state === 'running') return [{ kind: 'stop', primary: true, disabled: busy }]
  return []
}

const KNOWN_CODES = new Set([
  'active_elsewhere', 'session_gone', 'session_changed', 'folder_changed', 'folder_missing', 'bad_session_id', 'cli_missing',
  'bad_instruction', 'exit_nonzero', 'timeout', 'output_limit', 'spawn_failed', 'internal_error', 'cancelled', 'denied',
  'superseded', 'session_busy', 'too_many_running', 'already_used', 'unknown_proposal', 'native_only', 'instruction_too_long'
])

/** i18n key for a backend code; unknown codes get a generic message (a code is never shown raw). */
export function codeKey(code) {
  return KNOWN_CODES.has(code) ? `proposal.code.${code}` : 'proposal.code.generic'
}

/** What the card says about the current state, as keys and facts for the view. */
export function cardView(item, now, t) {
  const state = effectiveState(item, now)
  return {
    state,
    agent: item.agent === 'codex' ? t('agents.sourceCodex') : t('agents.sourceClaude'),
    title: item.title || t('agents.untitled'),
    folder: item.folder || t('agents.noFolder'),
    instruction: item.instruction || t('proposal.noInstruction'),
    instructionHidden: item.instructionFits ? 0 : item.instructionHidden,
    projectHooks: item.projectHooks,
    secondsLeft: secondsLeft(item, now),
    statusLine:
      state === 'running'
        ? t('proposal.running')
        : state === 'finished'
          ? t('proposal.finished')
          : state === 'failed'
            ? item.started
              ? t('proposal.failedRan', { reason: t(codeKey(item.code)) })
              : t('proposal.failedNotRun', { reason: t(codeKey(item.code)) })
            : state === 'cancelled'
              ? t('proposal.cancelled')
              : state === 'denied'
                ? t(item.code === 'superseded' ? 'proposal.superseded' : 'proposal.denied')
                : state === 'expired'
                  ? t('proposal.expired')
                  : '',
    output: item.output,
    outputTruncated: item.outputTruncated,
    exitCode: item.exitCode
  }
}

/** "4:07" for a countdown. */
export function clockLabel(seconds) {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * @param {{
 *   getState: () => ReturnType<typeof proposalsInitial>,
 *   dispatch: (action: object) => void,
 *   rest: (path: string, opts?: object) => Promise<any>,
 *   now?: () => number
 * }} deps
 */
export function createProposalController({ getState, dispatch, rest, now = Date.now }) {
  // Synchronous guards, so two clicks in the same tick cannot both pass.
  const inflight = new Set()

  async function refresh() {
    let result
    try {
      result = await rest('/proposals')
    } catch (error) {
      const message = cleanText(error && error.message ? error.message : '', 160)
      // 403 means Hermes did not give this window the native owner ticket: the card cannot be released from here.
      // Real shape, proved live in Hermes Desktop 0.23.0 (ctx.rest -> hermes:api): "<status>: <json body>", for example
      // `404: {"detail":"unknown_proposal"}`, so a refusal reads `403: {"detail":"native_only"}`.
      const unavailable = /^\s*403\b|native_only/i.test(message)
      dispatch({ type: 'proposals.fail', message, unavailable })
      return { ok: false, reason: unavailable ? 'unavailable' : 'failed' }
    }
    const items = normalizeProposalList(result, now())
    if (!items) {
      dispatch({ type: 'proposals.fail', message: 'Unexpected reply from the Reactor backend', unavailable: false })
      return { ok: false, reason: 'bad_reply' }
    }
    dispatch({ type: 'proposals.ok', items, at: now() })
    return { ok: true, count: items.length }
  }

  function find(id) {
    return getState().items.find(i => i.id === id)
  }

  async function send(id, kind, path) {
    inflight.add(id)
    dispatch({ type: 'proposal.sending', id, kind })
    let result
    try {
      result = await rest(path, { method: 'POST' })
    } catch (error) {
      const reason = cleanText(error && error.message ? error.message : '', 120)
      dispatch({ type: 'proposal.sendFailed', id, reason })
      inflight.delete(id)
      void refresh() // find out what really happened before anything can be sent again
      return { ok: false, reason: 'failed' }
    }
    inflight.delete(id)
    const item = result && result.proposal ? normalizeProposal(result.proposal, now()) : null
    if (item) dispatch({ type: 'proposal.update', item })
    else dispatch({ type: 'proposal.sendFailed', id, reason: '' })
    if (!result || result.ok !== true) {
      return { ok: false, reason: 'refused', code: typeof (result && result.error) === 'string' ? result.error : 'unknown' }
    }
    return { ok: true, state: item ? item.state : 'unknown' }
  }

  /** Run: only a real click, once per proposal. */
  async function run(id, event) {
    const item = find(id)
    if (!item) return { ok: false, reason: 'stale' }
    if (!isRealClick(event)) return { ok: false, reason: 'not_a_click' }
    if (inflight.has(id) || item.sending) return { ok: false, reason: 'busy' }
    if (effectiveState(item, now()) !== 'pending') return { ok: false, reason: 'not_pending' }
    if (!item.instructionFits) return { ok: false, reason: 'instruction_hidden' }
    return send(id, 'run', `/proposals/${encodeURIComponent(id)}/run`)
  }

  /** Deny a pending proposal, or stop a running one. Any trusted gesture. */
  async function deny(id, event) {
    const item = find(id)
    if (!item) return { ok: false, reason: 'stale' }
    if (!isTrustedGesture(event)) return { ok: false, reason: 'not_a_click' }
    if (inflight.has(id)) return { ok: false, reason: 'busy' }
    const state = effectiveState(item, now())
    if (state !== 'pending' && state !== 'running') return { ok: false, reason: 'not_pending' }
    return send(id, 'cancel', `/proposals/${encodeURIComponent(id)}/cancel`)
  }

  return { refresh, run, deny }
}
