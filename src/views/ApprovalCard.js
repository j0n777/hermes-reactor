// The approval card. It explains the request in three plain sections and offers the buttons
// the model allows. All the rules (real click only, one answer, stale ids) live in
// model/approval.js and model/approval-controller.js; this file only draws and forwards.
//
//  - Deny holds the focus (when the user is not typing elsewhere).
//  - Esc does nothing. There is no key that approves.
//  - Approve buttons need a real mouse click or tap; the controller refuses anything else.

import { useEffect, useRef, useState } from 'react'

import { approveBlock, buttonsFor, explain, shouldTakeFocus } from '../model/approval.js'
import { h } from './h.js'
import { getRuntime, useArmed } from './hooks.js'

const LABEL = { deny: 'approval.deny', once: 'approval.once', session: 'approval.session', always: 'approval.always' }

const NOTICE = {
  stale: 'approval.stale',
  must_expand: 'approval.mustExpand',
  too_long: 'approval.tooLong',
  not_a_click: 'approval.notAClick',
  offline: 'approval.reconnecting'
}

export function ApprovalCard({ card, t, paused = false, autoFocus = true }) {
  const rt = getRuntime()
  const rootRef = useRef(null)
  const denyRef = useRef(null)
  const [notice, setNotice] = useState('')

  // Pull focus to Deny when the card appears, unless the user is typing somewhere else.
  useEffect(() => {
    if (!autoFocus) return
    const root = rootRef.current
    const deny = denyRef.current
    if (!root || !deny || typeof document === 'undefined') return
    const active = document.activeElement
    if (shouldTakeFocus({ activeIsBody: !active || active === document.body, activeInsideRoot: root.closest('.jh-root')?.contains(active) ?? false })) {
      deny.focus({ preventScroll: true })
    }
  }, [card.key, autoFocus])

  const info = explain(card, t)
  const buttons = buttonsFor(card)
  const sending = card.status === 'sending'
  const failed = card.status === 'failed'
  const locked = sending || paused
  const block = approveBlock(card) // '' | 'must_expand' | 'too_long': a clipped command is opened before it is allowed
  // Anti-misclick: the approving buttons wait 700 ms after the card shows, and again after its text or size changes.
  const armed = useArmed(rootRef, [card.key, card.level, card.status, card.expanded, info.what, info.may.join('||'), info.why, paused, block].join('||'))

  async function onChoose(choice, event) {
    setNotice('')
    // Hand over the real DOM event: the controller checks isTrusted and detail on it.
    const out = await rt.controller.answer(card.key, choice, event.nativeEvent)
    if (!out.ok && NOTICE[out.reason]) setNotice(t(NOTICE[out.reason]))
    if (out.ok && out.handled === 'already') rt.notify({ kind: 'info', message: t('approval.alreadyHandled') })
  }

  function onExpand(event) {
    setNotice('')
    rt.controller.expand(card.key, event.nativeEvent)
  }

  // Esc is deliberately inert: it neither approves nor denies.
  function onKeyDown(event) {
    if (event.key === 'Escape') event.stopPropagation()
  }

  const titleId = `jh-ap-${card.key.replace(/[^a-zA-Z0-9_-]/g, '')}`

  return h(
    'section',
    { ref: rootRef, className: 'jh-approval', 'data-level': card.level, 'data-status': card.status, role: 'group', 'aria-labelledby': titleId, onKeyDown },
    h(
      'div',
      { className: 'jh-approval-head' },
      h('h3', { id: titleId, className: 'jh-approval-title' }, t('approval.title')),
      h('span', { className: 'jh-risk' }, info.riskLabel)
    ),
    h(
      'div',
      { className: 'jh-approval-body' },
    h('h4', null, t('approval.what')),
    card.clipped && !card.expanded
      ? h('div', { className: 'jh-approval-status jh-clip', 'data-tone': 'warn', role: 'alert' }, t('approval.clipped', { n: card.hiddenChars }))
      : null,
    h('pre', { className: card.expanded ? 'jh-code jh-code-full' : 'jh-code', tabIndex: card.clipped ? 0 : undefined }, info.what),
    card.clipped && !card.expanded && !card.unviewable
      ? h('button', { type: 'button', className: 'jh-btn jh-btn-sm jh-btn-expand', onClick: onExpand }, t('approval.showAll'))
      : null,
    card.clipped && card.expanded ? h('div', { className: 'jh-approval-hint' }, t('approval.showingAll')) : null,
    h('h4', null, t('approval.may')),
    h('ul', null, info.may.map((line, i) => h('li', { key: i }, line))),
    h('h4', null, t('approval.why')),
    h('p', null, info.why, card.toolName ? h('span', { className: 'jh-faint' }, `  (${t('approval.tool')}: ${card.toolName})`) : null),
    h('div', { id: `${titleId}-hint`, className: 'jh-approval-hint' }, t('approval.clickOnly'))
    ),
    h(
      'div',
      { className: 'jh-approval-statuses' },
      block ? h('div', { className: 'jh-approval-status', 'data-tone': 'warn', role: 'status' }, t(NOTICE[block])) : null,
      sending ? h('div', { className: 'jh-approval-status', role: 'status' }, t('approval.sending')) : null,
      failed
        ? h(
            'div',
            { className: 'jh-approval-status', 'data-tone': 'error', role: 'alert' },
            t('approval.failed', { reason: card.failure || t('approval.failedGeneric') }),
            ' ',
            t('approval.retryHint')
          )
        : null,
      paused ? h('div', { className: 'jh-approval-status', role: 'status' }, t('approval.reconnecting')) : null,
      notice ? h('div', { className: 'jh-approval-status', 'data-tone': 'error', role: 'alert' }, notice) : null
    ),
    h(
      'div',
      { className: 'jh-approval-actions' },
      buttons.map(b =>
        h(
          'button',
          {
            key: b.choice,
            ref: b.choice === 'deny' ? denyRef : undefined,
            type: 'button',
            className: b.primary ? 'jh-btn jh-btn-deny' : 'jh-btn jh-btn-allow',
            disabled: locked || (b.approving && (block !== '' || !armed)),
            'aria-describedby': b.approving ? `${titleId}-hint` : undefined,
            onClick: event => onChoose(b.choice, event)
          },
          t(LABEL[b.choice])
        )
      )
    )
  )
}

/** Every approval that is waiting is drawn (a hidden one could never be answered), in a list that scrolls. */
export function ApprovalList({ cards, t, paused }) {
  if (cards.length === 0) return null
  return h(
    'div',
    { className: 'jh-approvals jh-card-scroll', 'aria-live': 'assertive' },
    cards.length > 1 ? h('div', { className: 'jh-muted' }, t('approval.count', { n: cards.length })) : null,
    cards.map((card, i) => h(ApprovalCard, { key: card.key, card, t, paused, autoFocus: i === 0 }))
  )
}
