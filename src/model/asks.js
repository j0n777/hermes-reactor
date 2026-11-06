// "Ask another profile": the model and the controller behind the Send card.
//
// The Python tool `reactor_ask_profile` holds the proposal in server memory. This side lists it (`ctx.rest`), shows the exact
// text and names the target profile, and on a REAL click (isTrusted, type click, detail > 0) asks the backend to release it
// (once), then sends it to that profile with `host.requestProfile`.
//
// Which transport (decided from the Hermes 0.23.0 source):
//  - `bot_relay.deliver` is the Bot Chat bridge. It needs a 32 to 64 hex delivery id, a registered roster, the target
//    profile's own running authority, and it answers with a receipt; the reply is written to a mailbox file the sender
//    waits on. That is a lot of machinery owned by the Bots plugin, and a failure leaves a retained envelope behind.
//  - `session.create` + `prompt.submit` + `session.history` are plain gateway RPCs the Desktop itself uses. They go through
//    `host.requestProfile` (any profile route, no Bot Mode needed) and give back the reply as the transcript. Used here.
//    A non-retained secondary socket closes between calls and the gateway reaps the session it minted (SDK note, #93602), so
//    the whole exchange holds `host.retainProfile` and lets it go in a `finally`.
//
// The reply is untrusted text from another profile that has its own tools: it is cleaned, capped, shown on the card and never
// put in the chat or handed to the model. The model has no way to trigger any of this.

import { isRealClick, isTrustedGesture } from './approval.js'
import { instructionCheck } from './proposals.js'
import { cleanBlock, cleanText } from './sanitize.js'

export const ASK_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/
export const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
export const ASK_STATES = Object.freeze(['pending', 'released', 'denied', 'expired'])
export const REPLY_SHOWN_CHARS = 4000
export const ASK_TIMEOUT_MS = 10 * 60_000
export const ASK_POLL_MS = 1500
const RPC_TIMEOUT_MS = 60_000

export const MAX_PENDING = 5 // the backend refuses a sixth pending ask (reactor_hermes/asks.py MAX_PENDING)

/** What the card may claim about the target's approvals: 'on', 'off', or 'unverified' (also for anything unexpected). */
function approvalsOf(raw) {
  const status = raw && typeof raw === 'object' ? raw.status : ''
  return status === 'on' || status === 'off' ? status : 'unverified'
}

export function asksInitial() {
  return { status: 'loading', items: [], error: '', updatedAt: 0 }
}

/** One backend ask to a safe item. Null when it cannot be shown or answered safely. */
export function normalizeAsk(raw, receivedAt = 0) {
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.id !== 'string' || !ASK_ID_PATTERN.test(raw.id)) return null
  if (typeof raw.profile !== 'string' || !PROFILE_PATTERN.test(raw.profile)) return null
  const state = typeof raw.state === 'string' ? raw.state : ''
  if (!ASK_STATES.includes(state)) return null
  const remaining = typeof raw.remaining_s === 'number' && Number.isFinite(raw.remaining_s) ? Math.max(0, Math.floor(raw.remaining_s)) : 0
  const text = instructionCheck(raw.message)
  return {
    id: raw.id,
    label: cleanText(raw.label ?? '', 16),
    profile: raw.profile,
    state,
    message: text.shown,
    messageFits: text.fits,
    messageHidden: text.hidden,
    // Only 'off' and 'on' are believed, and only in the exact shape the backend sends; anything else counts as not verified.
    approvals: approvalsOf(raw.approvals),
    remainingS: remaining,
    receivedAt,
    phase: '',
    reply: '',
    failure: ''
  }
}

export function normalizeAskList(result, receivedAt = 0) {
  if (!result || typeof result !== 'object' || result.ok !== true || !Array.isArray(result.asks)) return null
  return result.asks.map(a => normalizeAsk(a, receivedAt)).filter(Boolean)
}

export function secondsLeft(item, now) {
  if (item.state !== 'pending') return 0
  return Math.max(0, item.remainingS - Math.floor((now - item.receivedAt) / 1000))
}

export function effectiveState(item, now) {
  return item.state === 'pending' && secondsLeft(item, now) <= 0 ? 'expired' : item.state
}

/** Deny first (it holds the focus), then Send; only while the ask is pending and not busy. */
export function buttonsFor(item, now) {
  if (effectiveState(item, now) !== 'pending') return []
  const busy = item.phase === 'sending' || item.phase === 'waiting'
  return [
    { kind: 'deny', primary: true, disabled: busy },
    { kind: 'send', primary: false, disabled: busy || !item.messageFits }
  ]
}

/**
 * Which items to draw: every pending one first (the person must be able to answer them all, and sees them before anything that
 * is already over), then the newest finished ones up to `max` in total.
 */
export function visibleItems(items, now, max = MAX_PENDING) {
  const pending = items.filter(i => effectiveState(i, now) === 'pending')
  const rest = items.filter(i => effectiveState(i, now) !== 'pending')
  const room = Math.max(0, max - pending.length)
  return [...pending, ...(room > 0 ? rest.slice(-room) : [])]
}

export function waitingCount(state, now) {
  return state.items.filter(i => effectiveState(i, now) === 'pending').length
}

export function asksReduce(state, action) {
  switch (action.type) {
    case 'asks.ok': {
      const prev = new Map(state.items.map(i => [i.id, i]))
      // An ask that is already over and that this window never showed (sent from another window, or before a reload) has
      // no text left to show: the backend wiped it. It is not drawn.
      const visible = action.items.filter(i => i.state === 'pending' || prev.has(i.id))
      const merged = visible.map(i => {
        const old = prev.get(i.id)
        if (!old) return i
        // The backend wipes the text after Send; the card keeps what the person read and what came back.
        return {
          ...i,
          message: i.message || old.message,
          messageFits: i.message ? i.messageFits : old.messageFits,
          phase: old.phase,
          reply: old.reply,
          failure: old.failure
        }
      })
      const listed = new Set(merged.map(i => i.id))
      const kept = state.items.filter(i => !listed.has(i.id) && (i.phase === 'sending' || i.phase === 'waiting' || i.phase === 'replied' || i.phase === 'failed'))
      const items = [...merged, ...kept]
      return { status: items.length ? 'ready' : 'empty', items, error: '', updatedAt: action.at }
    }
    case 'asks.fail':
      return { ...state, status: action.unavailable ? 'unavailable' : 'error', error: cleanText(action.message ?? '', 160) }
    case 'ask.patch':
      return { ...state, items: state.items.map(i => (i.id === action.id ? { ...i, ...action.patch } : i)) }
    case 'ask.update': {
      const known = state.items.some(i => i.id === action.item.id)
      const items = known ? state.items.map(i => (i.id === action.item.id ? { ...action.item, message: action.item.message || i.message, messageFits: action.item.message ? action.item.messageFits : i.messageFits, phase: i.phase, reply: i.reply, failure: i.failure } : i)) : [...state.items, action.item]
      return { ...state, status: 'ready', items }
    }
    case 'ask.dismiss':
      return { ...state, items: state.items.filter(i => i.id !== action.id) }
    default:
      return state
  }
}

/** The route whose backend profile is `profile`, or null when there is none or it is ambiguous. */
export function pickRoute(routes, profile) {
  if (!Array.isArray(routes)) return null
  const ok = routes.filter(r => r && typeof r === 'object' && typeof r.connectionId === 'string' && r.connectionId.trim() && typeof r.profile === 'string' && r.profile.trim() && r.targetProfile === profile)
  if (ok.length === 1) return ok[0]
  const primary = ok.filter(r => r.primary === true)
  return primary.length === 1 ? primary[0] : null
}

function textOf(message) {
  if (!message || typeof message !== 'object') return ''
  if (typeof message.text === 'string' && message.text) return message.text
  const c = message.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map(p => (p && typeof p.text === 'string' ? p.text : typeof p === 'string' ? p : '')).filter(Boolean).join('\n')
  return ''
}

/** The assistant text after the last user message of a `session.history` reply. `final` once an assistant answer is last. */
export function extractReply(history) {
  const list = history && typeof history === 'object' && Array.isArray(history.messages) ? history.messages : []
  let from = -1
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i] && list[i].role === 'user') {
      from = i
      break
    }
  }
  const after = list.slice(from + 1)
  const parts = after.filter(m => m && m.role === 'assistant').map(textOf).filter(Boolean)
  const last = after[after.length - 1]
  const final = Boolean(last) && last.role === 'assistant' && textOf(last).length > 0
  return { text: parts.join('\n'), final }
}

/**
 * @param {{
 *   getState: () => ReturnType<typeof asksInitial>,
 *   dispatch: (a: object) => void,
 *   rest: (path: string, opts?: object) => Promise<any>,
 *   routes: () => Promise<object[]>,
 *   requestProfile: (route: object, method: string, params: object, timeoutMs?: number, opts?: object) => Promise<any>,
 *   retainProfile?: (route: object, opts?: object) => Promise<() => void>,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   timeoutMs?: number,
 *   pollMs?: number
 * }} deps
 */
export function createAskController({ getState, dispatch, rest, routes, requestProfile, retainProfile, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), timeoutMs = ASK_TIMEOUT_MS, pollMs = ASK_POLL_MS }) {
  const inflight = new Set()

  const find = id => getState().items.find(i => i.id === id)
  const patch = (id, p) => dispatch({ type: 'ask.patch', id, patch: p })
  const fail = (id, code, text = '') => {
    patch(id, { phase: code === 'no_route' || code === 'refused' ? '' : 'failed', failure: text ? cleanText(text, 160) : code })
    return code
  }

  async function refresh() {
    let result
    try {
      result = await rest('/asks')
    } catch (error) {
      const message = cleanText(error && error.message ? error.message : '', 160)
      const unavailable = /^\s*403\b|native_only/i.test(message)
      dispatch({ type: 'asks.fail', message, unavailable })
      return { ok: false, reason: unavailable ? 'unavailable' : 'failed' }
    }
    const items = normalizeAskList(result, now())
    if (!items) {
      dispatch({ type: 'asks.fail', message: 'Unexpected reply from the Reactor backend', unavailable: false })
      return { ok: false, reason: 'bad_reply' }
    }
    dispatch({ type: 'asks.ok', items, at: now() })
    return { ok: true, count: items.length }
  }

  async function exchange(route, text) {
    const opts = { spawnPriority: 'foreground' }
    let release = () => {}
    if (typeof retainProfile === 'function') {
      try {
        release = (await retainProfile(route, opts)) || release
      } catch {
        release = () => {}
      }
    }
    try {
      const created = await requestProfile(route, 'session.create', {}, RPC_TIMEOUT_MS, opts)
      const sessionId = created && typeof created.session_id === 'string' ? created.session_id : ''
      if (!sessionId) throw new Error('The other profile did not open a session')
      await requestProfile(route, 'prompt.submit', { session_id: sessionId, text }, RPC_TIMEOUT_MS, opts)
      const deadline = now() + timeoutMs
      let previous = null
      while (now() < deadline) {
        await sleep(pollMs)
        const history = await requestProfile(route, 'session.history', { session_id: sessionId }, RPC_TIMEOUT_MS, opts)
        const reply = extractReply(history)
        if (reply.final && previous !== null && previous === reply.text) return reply.text
        previous = reply.final ? reply.text : null
      }
      return null
    } finally {
      try {
        release()
      } catch {
        // Letting go is best effort.
      }
    }
  }

  /** Send: only a real click, once per ask. The backend releases the exact text a single time. */
  async function send(id, event) {
    const item = find(id)
    if (!item) return { ok: false, reason: 'stale' }
    if (!isRealClick(event)) return { ok: false, reason: 'not_a_click' }
    if (inflight.has(id) || item.phase === 'sending' || item.phase === 'waiting') return { ok: false, reason: 'busy' }
    if (effectiveState(item, now()) !== 'pending') return { ok: false, reason: 'not_pending' }
    if (!item.messageFits) return { ok: false, reason: 'message_hidden' }
    inflight.add(id)
    try {
      patch(id, { phase: 'sending', failure: '' })
      let route = null
      try {
        route = pickRoute(await routes(), item.profile)
      } catch {
        route = null
      }
      // Find the road first: a missing route must not use up the ask.
      if (!route) {
        fail(id, 'no_route')
        return { ok: false, reason: 'no_route' }
      }
      let released
      try {
        released = await rest(`/asks/${encodeURIComponent(id)}/release`, { method: 'POST' })
      } catch (error) {
        fail(id, 'release_failed', error && error.message)
        return { ok: false, reason: 'release_failed' }
      }
      if (!released || released.ok !== true || !released.ask) {
        const code = typeof (released && released.error) === 'string' ? released.error : 'unknown'
        fail(id, 'refused', code)
        void refresh()
        return { ok: false, reason: 'refused', code }
      }
      const { profile, message } = released.ask
      if (profile !== item.profile || typeof message !== 'string') {
        fail(id, 'mismatch')
        return { ok: false, reason: 'mismatch' }
      }
      patch(id, { phase: 'waiting', state: 'released' })
      let reply
      try {
        reply = await exchange(route, message)
      } catch (error) {
        fail(id, 'send_failed', error && error.message ? error.message : 'send failed')
        return { ok: false, reason: 'send_failed' }
      }
      if (reply === null) {
        fail(id, 'timeout')
        return { ok: false, reason: 'timeout' }
      }
      patch(id, { phase: 'replied', reply: cleanBlock(reply, REPLY_SHOWN_CHARS, 60), failure: '' })
      return { ok: true }
    } finally {
      inflight.delete(id)
    }
  }

  async function deny(id, event) {
    const item = find(id)
    if (!item) return { ok: false, reason: 'stale' }
    if (!isTrustedGesture(event)) return { ok: false, reason: 'not_a_click' }
    if (inflight.has(id)) return { ok: false, reason: 'busy' }
    let result
    try {
      result = await rest(`/asks/${encodeURIComponent(id)}/deny`, { method: 'POST' })
    } catch (error) {
      patch(id, { failure: cleanText(error && error.message ? error.message : '', 160) })
      return { ok: false, reason: 'failed' }
    }
    const updated = result && result.ask ? normalizeAsk(result.ask, now()) : null
    if (updated) dispatch({ type: 'ask.update', item: updated })
    return { ok: Boolean(result && result.ok === true) }
  }

  return { refresh, send, deny }
}
