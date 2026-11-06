// The plugin state: one pure reducer and pure selectors. No timers, no clock reads, no
// I/O. Time is always passed in. Tested without a DOM.

import { makeCard } from './approval.js'
import { dict, put } from './dict.js'

export const REACTOR_STATES = Object.freeze([
  'idle',
  'listening',
  'transcribing',
  'thinking',
  'responding',
  'approval',
  'error',
  'offline'
])

export const TIMING = Object.freeze({
  voiceStaleMs: 120_000,
  wakeListenMs: 20_000,
  errorShowMs: 15_000,
  phaseStaleMs: 90_000,
  heardShowMs: 9_000,
  feedMax: 8,
  resolvedKeep: 64
})

export function initialState() {
  return {
    host: { gateway: 'idle', busy: false, awaiting: false, focusedSessionId: null, activeSessionId: null },
    voice: { state: 'idle', since: 0, wakeAt: 0 },
    heard: { text: '', at: 0, final: false },
    sessions: dict(),
    error: null,
    approvals: [],
    resolved: [],
    feed: []
  }
}

function pushFeed(state, kind, at, extra = {}) {
  const last = state.feed[state.feed.length - 1]
  if (last && last.kind === kind && at - last.at < 600) return state.feed
  const next = [...state.feed, { id: `${at}:${state.feed.length}:${kind}`, kind, at, ...extra }]
  return next.length > TIMING.feedMax ? next.slice(next.length - TIMING.feedMax) : next
}

function setPhase(state, sessionId, phase, at) {
  const prev = state.sessions[sessionId]
  const sessions = put(state.sessions, sessionId, { phase, since: prev?.phase === phase ? prev.since : at, lastAt: at })
  return { ...state, sessions }
}

function upsertCard(state, card) {
  const index = state.approvals.findIndex(c => c.key === card.key)
  if (index === -1) return { ...state, approvals: [...state.approvals, card] }
  const existing = state.approvals[index]
  // Keep the in-flight or failed status; refresh the content.
  const merged = {
    ...card,
    status: existing.status,
    failure: existing.failure,
    receivedAt: existing.receivedAt,
    expanded: existing.expanded === true && existing.commandFull === card.commandFull
  }
  const approvals = state.approvals.slice()
  approvals[index] = merged
  return { ...state, approvals }
}

function dropCards(state, predicate) {
  const approvals = state.approvals.filter(c => !predicate(c))
  return approvals.length === state.approvals.length ? state : { ...state, approvals }
}

function remember(state, keys) {
  const add = Array.isArray(keys) ? keys : [keys]
  const resolved = [...state.resolved.filter(k => !add.includes(k)), ...add]
  return resolved.length > TIMING.resolvedKeep ? resolved.slice(resolved.length - TIMING.resolvedKeep) : resolved
}

/**
 * @param {ReturnType<typeof initialState>} state
 * @param {{ type: string, at?: number, [k: string]: unknown }} action
 */
export function reduce(state, action) {
  const at = typeof action.at === 'number' ? action.at : 0

  switch (action.type) {
    case 'host':
      return { ...state, host: { ...state.host, ...action.patch } }

    case 'wake': {
      // Hermes heard the wake word: the next thing it does is listen. This lasts until a turn
      // starts (turn.start clears wakeAt) or TIMING.wakeListenMs passes, whichever is first.
      return {
        ...state,
        error: null,
        voice: { ...state.voice, wakeAt: at },
        feed: pushFeed(state, 'wake', at)
      }
    }

    case 'voice.status': {
      const next = action.state
      if (next === state.voice.state) return { ...state, voice: { ...state.voice, since: state.voice.since || at } }
      const feed = next === 'idle' ? state.feed : pushFeed(state, next, at)
      return {
        ...state,
        error: next === 'listening' ? null : state.error,
        voice: { ...state.voice, state: next, since: at },
        feed
      }
    }

    case 'voice.partial':
      if (!action.text) return state
      return { ...state, heard: { text: action.text, at, final: false } }

    case 'voice.transcript': {
      if (!action.text) return { ...state, voice: { ...state.voice, state: 'idle', since: at } }
      return {
        ...state,
        voice: { ...state.voice, state: 'idle', since: at },
        heard: { text: action.text, at, final: true },
        feed: pushFeed(state, 'transcript', at)
      }
    }

    case 'voice.interrupted':
      return { ...state, voice: { ...state.voice, state: 'idle', since: at }, feed: pushFeed(state, 'interrupted', at) }

    case 'turn.start': {
      const next = setPhase(state, action.sessionId, 'thinking', at)
      return { ...next, error: null, voice: { ...next.voice, wakeAt: 0 }, feed: pushFeed(next, 'thinking', at) }
    }

    case 'turn.thinking': {
      const prev = state.sessions[action.sessionId]
      if (prev?.phase === 'thinking') return setPhase(state, action.sessionId, 'thinking', at)
      const next = setPhase(state, action.sessionId, 'thinking', at)
      return { ...next, feed: prev ? next.feed : pushFeed(next, 'thinking', at) }
    }

    case 'turn.delta': {
      const prev = state.sessions[action.sessionId]
      const next = setPhase(state, action.sessionId, 'responding', at)
      return prev?.phase === 'responding' ? next : { ...next, feed: pushFeed(next, 'responding', at) }
    }

    case 'turn.complete': {
      const next = setPhase(state, action.sessionId, 'idle', at)
      if (action.status === 'error') {
        return {
          ...next,
          error: { at, sessionId: action.sessionId, message: action.failure || '' },
          feed: pushFeed(next, 'error', at)
        }
      }
      if (action.status === 'interrupted') return { ...next, feed: pushFeed(next, 'interrupted', at) }
      return { ...next, feed: pushFeed(next, 'done', at) }
    }

    case 'error':
      return {
        ...state,
        error: { at, sessionId: action.sessionId, message: action.message || '' },
        feed: pushFeed(state, 'error', at)
      }

    case 'error.clear':
      return state.error ? { ...state, error: null } : state

    case 'approval.request': {
      const card = makeCard(action, at)
      if (!card) return state
      if (state.resolved.includes(card.key)) return state
      const had = state.approvals.some(c => c.key === card.key)
      const next = upsertCard(state, card)
      return had ? next : { ...next, feed: pushFeed(next, 'approvalAsked', at) }
    }

    case 'approval.sync': {
      // `approval.pending` for one session is the truth for that session.
      let next = state
      const seen = new Set()
      for (const item of action.items) {
        const card = makeCard({ ...item, sessionId: action.sessionId }, at)
        if (!card || state.resolved.includes(card.key)) continue
        seen.add(card.key)
        next = upsertCard(next, card)
      }
      next = dropCards(next, c => c.sessionId === action.sessionId && !seen.has(c.key) && c.status !== 'sending')
      return next
    }

    case 'approval.settled': {
      const hit = state.approvals.filter(c => c.requestId === action.requestId)
      if (hit.length === 0) return state
      const next = { ...dropCards(state, c => c.requestId === action.requestId), resolved: remember(state, hit.map(c => c.key)) }
      return { ...next, feed: pushFeed(next, 'approvalSettled', at) }
    }

    case 'approval.cancelled': {
      const ids = new Set(action.requestIds)
      const drop = ids.size > 0
        ? c => ids.has(c.requestId)
        : action.count > 0 && action.sessionId
          ? c => c.sessionId === action.sessionId
          : () => false
      const hit = state.approvals.filter(drop)
      if (hit.length === 0) return state
      const next = { ...dropCards(state, drop), resolved: remember(state, hit.map(c => c.key)) }
      return { ...next, feed: pushFeed(next, 'approvalCancelled', at) }
    }

    case 'approval.expand':
      return patchCard(state, action.key, c => (c.expanded ? c : { ...c, expanded: true }))

    case 'approval.sending':
      return patchCard(state, action.key, c => (c.status === 'sending' ? c : { ...c, status: 'sending', failure: '', choiceSent: action.choice }))

    case 'approval.failed':
      return patchCard(state, action.key, c => ({ ...c, status: 'failed', failure: action.reason || '', choiceSent: undefined }))

    case 'approval.answered': {
      const card = state.approvals.find(c => c.key === action.key)
      if (!card) return state
      const next = { ...dropCards(state, c => c.key === action.key), resolved: remember(state, action.key) }
      return { ...next, feed: pushFeed(next, 'approvalAnswered', at) }
    }

    case 'approval.gone': {
      const card = state.approvals.find(c => c.key === action.key)
      if (!card) return state
      return { ...dropCards(state, c => c.key === action.key), resolved: remember(state, action.key) }
    }

    default:
      return state
  }
}

function patchCard(state, key, fn) {
  const index = state.approvals.findIndex(c => c.key === key)
  if (index === -1) return state
  const approvals = state.approvals.slice()
  approvals[index] = fn(approvals[index])
  return { ...state, approvals }
}

// ---- selectors -------------------------------------------------------------

function currentPhase(state, now) {
  const fresh = s => s && s.phase !== 'idle' && now - s.lastAt <= TIMING.phaseStaleMs
  const focused = state.host.focusedSessionId ?? state.host.activeSessionId
  if (focused && fresh(state.sessions[focused])) return state.sessions[focused].phase
  let best = null
  for (const s of Object.values(state.sessions)) {
    if (fresh(s) && (!best || s.lastAt > best.lastAt)) best = s
  }
  return best ? best.phase : 'idle'
}

export function pendingApprovals(state) {
  return state.approvals
}

/** The one state the reactor should show right now. */
export function selectReactorState(state, now) {
  if (state.host.gateway !== 'open') return 'offline'
  if (state.approvals.length > 0) return 'approval'
  if (state.error && now - state.error.at <= TIMING.errorShowMs) return 'error'

  const voiceFresh = now - state.voice.since <= TIMING.voiceStaleMs
  if (state.voice.state === 'listening' && voiceFresh) return 'listening'
  if (state.voice.state === 'transcribing' && voiceFresh) return 'transcribing'
  if (state.voice.wakeAt && now - state.voice.wakeAt <= TIMING.wakeListenMs) return 'listening'

  const phase = currentPhase(state, now)
  if (phase === 'responding') return 'responding'
  if (phase === 'thinking') return 'thinking'
  if (state.host.busy || state.host.awaiting) return 'thinking'
  return 'idle'
}

/** The text Hermes reported hearing, only while it is recent. */
export function selectHeard(state, now) {
  const { text, at, final } = state.heard
  if (!text || now - at > TIMING.heardShowMs) return null
  return { text, final }
}

/** Error detail, only while it is recent. */
export function selectError(state, now) {
  return state.error && now - state.error.at <= TIMING.errorShowMs ? state.error : null
}
