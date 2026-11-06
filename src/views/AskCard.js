// The Send card for "ask another profile". Large on purpose: it names the target profile, shows the EXACT message, and warns
// that the other profile has its own tools. Deny holds the focus. Send works with a real mouse click or tap only
// (`event.detail > 0`); the controller refuses anything else. The reply is untrusted text kept on this card: it is never put
// into the chat and never handed back to the model.

import { useEffect, useRef, useState } from 'react'

import { shouldTakeFocus } from '../model/approval.js'
import { MAX_PENDING, buttonsFor, effectiveState, secondsLeft, visibleItems } from '../model/asks.js'
import { clockLabel } from '../model/proposals.js'
import { h } from './h.js'
import { getRuntime, useArmed, useAsksState, useNow } from './hooks.js'

const KNOWN = new Set(['no_route', 'refused', 'already_used', 'unknown_proposal', 'timeout', 'send_failed', 'release_failed', 'mismatch'])

function reasonText(code, t) {
  return t(KNOWN.has(code) ? `ask.code.${code}` : 'ask.code.generic')
}

export function AskCard({ item, t, now, autoFocus = true }) {
  const rt = getRuntime()
  const rootRef = useRef(null)
  const denyRef = useRef(null)
  const [notice, setNotice] = useState('')

  const state = effectiveState(item, now)
  const pending = state === 'pending' && item.phase === ''
  const buttons = buttonsFor(item, now)
  const busy = item.phase === 'sending' || item.phase === 'waiting'
  // Anti-misclick: Send waits 700 ms after the card shows, and again after its words, target or warnings change.
  const armed = useArmed(rootRef, [item.id, item.profile, item.message, item.approvals, item.messageFits, item.phase, state].join('||'))

  useEffect(() => {
    if (!autoFocus || !pending) return
    const root = rootRef.current
    const deny = denyRef.current
    if (!root || !deny || typeof document === 'undefined') return
    const active = document.activeElement
    if (shouldTakeFocus({ activeIsBody: !active || active === document.body, activeInsideRoot: root.closest('.jh-root')?.contains(active) ?? false })) {
      deny.focus({ preventScroll: true })
    }
  }, [item.id, autoFocus, pending])

  async function onSend(event) {
    setNotice('')
    const out = await rt.askController.send(item.id, event.nativeEvent)
    if (out.ok) return
    if (out.reason === 'not_a_click') setNotice(t('ask.notAClick'))
    else if (out.reason === 'message_hidden') setNotice(t('ask.hiddenChars', { n: item.messageHidden }))
  }

  async function onDeny(event) {
    setNotice('')
    await rt.askController.deny(item.id, event.nativeEvent)
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') event.stopPropagation() // Esc neither sends nor denies
  }

  const titleId = `jh-ask-${item.id.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const field = (label, body) => h('div', { className: 'jh-pr-field' }, h('h4', null, label), body)
  const finished = item.phase === 'replied' || item.phase === 'failed'
  const status =
    item.phase === 'sending'
      ? t('ask.sending')
      : item.phase === 'waiting'
        ? t('ask.waiting', { profile: item.profile })
        : item.phase === 'failed'
          ? t('ask.failed', { reason: reasonText(item.failure, t) })
          : item.failure && item.phase === ''
            ? t('ask.failed', { reason: reasonText(item.failure, t) })
            : state === 'denied'
              ? t('ask.denied')
              : state === 'expired' && item.phase === ''
                ? t('ask.expired')
                : state === 'released' && item.phase === ''
                  ? t('ask.released')
                  : ''

  return h(
    'section',
    { ref: rootRef, className: 'jh-approval jh-proposal jh-ask', 'data-level': pending || busy ? 'unknown' : 'safe', 'data-status': item.phase || state, role: 'group', 'aria-labelledby': titleId, onKeyDown },
    h(
      'div',
      { className: 'jh-approval-head' },
      h('h3', { id: titleId, className: 'jh-approval-title jh-pr-title' }, t('ask.title')),
      pending ? h('span', { className: 'jh-risk', role: 'timer' }, t('ask.expiresIn', { time: clockLabel(secondsLeft(item, now)) })) : null
    ),
    h(
      'div',
      { className: 'jh-approval-body' },
      field(t('ask.profile'), h('p', { className: 'jh-pr-agent' }, item.profile)),
      pending || busy ? approvalsBanner(item, t) : null,
      field(t('ask.message'), h('pre', { className: 'jh-code jh-pr-instruction', tabIndex: 0 }, item.message || '-')),
      pending && !item.messageFits ? h('div', { className: 'jh-approval-status jh-pr-hidden', 'data-tone': 'error', role: 'alert' }, t('ask.hiddenChars', { n: item.messageHidden })) : null,
      pending || busy ? h('p', { className: 'jh-pr-perm' }, t('ask.warn')) : null,
      item.phase === 'replied' ? field(t('ask.replied', { profile: item.profile }), h('pre', { className: 'jh-code jh-pr-output', 'data-testid': 'ask-reply' }, item.reply || '-')) : null,
      pending ? h('div', { id: `${titleId}-hint`, className: 'jh-approval-hint' }, t('ask.clickOnly')) : null
    ),
    h(
      'div',
      { className: 'jh-approval-statuses' },
      status ? h('div', { className: 'jh-approval-status', 'data-tone': item.phase === 'failed' || item.failure ? 'error' : undefined, role: item.phase === 'failed' ? 'alert' : 'status' }, status) : null,
      notice ? h('div', { className: 'jh-approval-status', 'data-tone': 'error', role: 'alert' }, notice) : null
    ),
    buttons.length && !busy
      ? h(
          'div',
          { className: 'jh-approval-actions' },
          buttons.map(b =>
            h(
              'button',
              {
                key: b.kind,
                ref: b.kind === 'deny' ? denyRef : undefined,
                type: 'button',
                className: b.primary ? 'jh-btn jh-btn-deny jh-btn-big' : 'jh-btn jh-btn-allow jh-btn-big',
                disabled: b.disabled || (b.kind === 'send' && !armed),
                'aria-describedby': b.kind === 'send' ? `${titleId}-hint` : undefined,
                onClick: b.kind === 'send' ? onSend : onDeny
              },
              t(b.kind === 'send' ? 'ask.send' : 'ask.deny')
            )
          )
        )
      : null,
    finished || state === 'denied' || state === 'expired' ? h('div', { className: 'jh-approval-actions' }, h('button', { type: 'button', className: 'jh-linkbtn', onClick: () => rt.asks.dispatch({ type: 'ask.dismiss', id: item.id }) }, t('ask.dismiss'))) : null
  )
}

/** The red (or amber) line about the target profile's own approvals; nothing when they are on. */
function approvalsBanner(item, t) {
  if (item.approvals === 'on') return null
  const off = item.approvals === 'off'
  return h(
    'div',
    { className: 'jh-ask-banner', 'data-tone': off ? 'danger' : 'warn', role: 'alert' },
    t(off ? 'ask.approvalsOff' : 'ask.approvalsUnverified', { profile: item.profile })
  )
}

/** The ask cards: every one waiting for a click (up to the backend cap), then the newest answers, in a scrolling list. */
export function AskList({ t, max = MAX_PENDING, notes = false }) {
  const state = useAsksState()
  const now = useNow()
  const items = visibleItems(state.items, now, max)
  if (items.length === 0) {
    if (!notes) return null
    if (state.status === 'unavailable') return h('p', { className: 'jh-faint jh-pr-note' }, t('ask.unavailable'))
    if (state.status === 'error') return h('p', { className: 'jh-faint jh-pr-note' }, t('ask.loadError', { reason: state.error || '-' }))
    return null
  }
  return h(
    'div',
    { className: 'jh-approvals jh-card-scroll', 'aria-live': 'assertive' },
    items.map((item, i) => h(AskCard, { key: item.id, item, t, now, autoFocus: i === items.length - 1 }))
  )
}
