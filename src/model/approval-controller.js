// Answering and syncing approvals. All I/O is injected so the rules can be tested:
//  - one answer per request (a second click while sending is ignored);
//  - a request that is no longer pending is never answered (stale request_id);
//  - approving needs a real trusted click, denying needs any trusted gesture;
//  - a failure is shown and the card stays answerable again, nothing is retried silently;
//  - `approval.pending` is the truth for a session when we (re)load or reconnect.

import { approveBlock, isApproving, isChoiceAllowed, isRealClick, isTrustedGesture } from './approval.js'
import { pendingToItem } from './events.js'
import { cleanText } from './sanitize.js'

/**
 * @param {{
 *   getState: () => ReturnType<import('./state.js').initialState>,
 *   dispatch: (action: object) => void,
 *   request: (method: string, params: object, timeoutMs?: number) => Promise<any>,
 *   timeoutMs?: number,
 *   now?: () => number
 * }} deps
 */
export function createApprovalController({ getState, dispatch, request, timeoutMs, now = Date.now }) {
  const syncSeq = new Map()

  async function answer(key, choice, event) {
    const state = getState()
    if (state.host.gateway !== 'open') return { ok: false, reason: 'offline' }

    const card = state.approvals.find(c => c.key === key)
    if (!card) return { ok: false, reason: 'stale' }
    if (card.status === 'sending') return { ok: false, reason: 'busy' }
    if (!isChoiceAllowed(card, choice)) return { ok: false, reason: 'not_offered' }

    // A clipped command must have been opened (the whole text on screen) before anything is approved.
    if (isApproving(choice) && approveBlock(card)) return { ok: false, reason: approveBlock(card) }

    const gestureOk = isApproving(choice) ? isRealClick(event) : isTrustedGesture(event)
    if (!gestureOk) return { ok: false, reason: 'not_a_click' }

    // Synchronous: from here on the card is "sending", so a double click cannot send twice.
    dispatch({ type: 'approval.sending', key, choice, at: now() })

    let result
    try {
      result = await request(
        'approval.respond',
        { session_id: card.sessionId, request_id: card.requestId, choice },
        timeoutMs
      )
    } catch (error) {
      const reason = cleanText(error && error.message ? error.message : '', 120)
      dispatch({ type: 'approval.failed', key, reason, at: now() })
      return { ok: false, reason: 'failed' }
    }

    const resolved = result && typeof result === 'object' ? Number(result.resolved) : NaN
    if (resolved === 0) {
      // The gateway had nothing left to resolve: someone else answered, or it expired.
      dispatch({ type: 'approval.gone', key, at: now() })
      return { ok: true, handled: 'already' }
    }
    dispatch({ type: 'approval.answered', key, choice, at: now() })
    return { ok: true, handled: 'answered' }
  }

  /** The person opened the whole command. Needs a trusted gesture, like every answer. */
  function expand(key, event) {
    const card = getState().approvals.find(c => c.key === key)
    if (!card) return { ok: false, reason: 'stale' }
    if (!isTrustedGesture(event)) return { ok: false, reason: 'not_a_click' }
    dispatch({ type: 'approval.expand', key })
    return { ok: true }
  }

  /** Ask the gateway what is pending for a session and make the cards match. */
  async function syncSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return { ok: false, reason: 'no_session' }
    if (getState().host.gateway !== 'open') return { ok: false, reason: 'offline' }
    const seq = (syncSeq.get(sessionId) ?? 0) + 1
    syncSeq.set(sessionId, seq)

    let result
    try {
      result = await request('approval.pending', { session_id: sessionId })
    } catch {
      return { ok: false, reason: 'failed' }
    }
    if (syncSeq.get(sessionId) !== seq) return { ok: false, reason: 'superseded' }
    if (!result || !Array.isArray(result.approvals)) return { ok: false, reason: 'bad_reply' }

    const items = result.approvals.map(pendingToItem).filter(Boolean)
    dispatch({ type: 'approval.sync', sessionId, items, at: now() })
    return { ok: true, count: items.length }
  }

  /** Sessions that currently have a card, plus the focused one. */
  function sessionsToSync() {
    const state = getState()
    const ids = new Set(state.approvals.map(c => c.sessionId))
    const focused = state.host.focusedSessionId ?? state.host.activeSessionId
    if (focused) ids.add(focused)
    return [...ids]
  }

  return { answer, expand, syncSession, sessionsToSync }
}
