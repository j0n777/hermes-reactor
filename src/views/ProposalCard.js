// The "click to run" card for a continue-session proposal. Large on purpose: it shows the agent, the session,
// the folder and the EXACT instruction, and says that the agent runs under its own permission settings.
//
//  - Deny holds the focus (when the user is not typing elsewhere). Esc does nothing.
//  - Run works with a real mouse click or tap only (`event.detail > 0`); the controller refuses anything else.
//  - A double click sends once. Running, finished, failed and expired are all shown on the card.
//  - Every string from outside (title, folder, instruction, the agent output) is untrusted text, drawn as text.
//    The output stays on this card: it is never put into the chat or handed to a model.

import { useEffect, useRef, useState } from 'react'

import { shouldTakeFocus } from '../model/approval.js'
import { MAX_PENDING, buttonsFor, cardView, clockLabel, codeKey, visibleItems } from '../model/proposals.js'
import { h } from './h.js'
import { getRuntime, useArmed, useNow, useProposalsState } from './hooks.js'

const LABEL = { deny: 'proposal.deny', run: 'proposal.run', stop: 'proposal.stop' }

export function ProposalCard({ item, t, now, autoFocus = true }) {
  const rt = getRuntime()
  const rootRef = useRef(null)
  const denyRef = useRef(null)
  const [notice, setNotice] = useState('')

  const view = cardView(item, now, t)
  const buttons = buttonsFor(item, now)
  const pending = view.state === 'pending'
  // Anti-misclick: Run waits 700 ms after the card shows, and again after what it says or its size changes.
  const armed = useArmed(rootRef, [item.id, view.state, view.agent, view.title, view.folder, view.instruction, view.projectHooks.join(','), item.sending, item.failure].join('||'))
  const showOutput = view.state === 'running' || view.state === 'finished' || view.state === 'failed' || view.state === 'cancelled'

  // Pull focus to Deny when a pending card appears, unless the user is typing somewhere else.
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

  async function onRun(event) {
    setNotice('')
    // The real DOM event goes to the controller: it checks isTrusted, type and detail.
    const out = await rt.proposalController.run(item.id, event.nativeEvent)
    if (out.ok) return
    if (out.reason === 'not_a_click') setNotice(t('proposal.notAClick'))
    else if (out.reason === 'instruction_hidden') setNotice(t('proposal.instructionHidden', { n: item.instructionHidden }))
    else if (out.reason === 'refused') setNotice(t(codeKey(out.code)))
  }

  async function onDeny(event) {
    setNotice('')
    await rt.proposalController.deny(item.id, event.nativeEvent)
  }

  // Esc is deliberately inert: it neither runs nor denies.
  function onKeyDown(event) {
    if (event.key === 'Escape') event.stopPropagation()
  }

  const titleId = `jh-pr-${item.id.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const field = (label, body) => h('div', { className: 'jh-pr-field' }, h('h4', null, label), body)

  return h(
    'section',
    { ref: rootRef, className: 'jh-approval jh-proposal', 'data-level': pending || view.state === 'running' ? 'unknown' : 'safe', 'data-status': view.state, role: 'group', 'aria-labelledby': titleId, onKeyDown },
    h(
      'div',
      { className: 'jh-approval-head' },
      h('h3', { id: titleId, className: 'jh-approval-title jh-pr-title' }, t('proposal.title')),
      pending ? h('span', { className: 'jh-risk', role: 'timer' }, t('proposal.expiresIn', { time: clockLabel(view.secondsLeft) })) : null
    ),
    h(
      'div',
      { className: 'jh-approval-body' },
    field(t('proposal.agent'), h('p', { className: 'jh-pr-agent' }, view.agent)),
    field(t('proposal.session'), h('p', null, view.title)),
    field(t('proposal.folder'), h('pre', { className: 'jh-code jh-pr-folder' }, view.folder)),
    field(t('proposal.instruction'), h('pre', { className: 'jh-code jh-pr-instruction', tabIndex: 0 }, view.instruction)),
    pending && view.instructionHidden
      ? h('div', { className: 'jh-approval-status jh-pr-hidden', 'data-tone': 'error', role: 'alert' }, t('proposal.instructionHidden', { n: view.instructionHidden }))
      : null,
    h('p', { className: 'jh-pr-perm' }, t('proposal.permissions', { agent: view.agent })),
    pending && item.agent === 'claude' ? h('p', { className: 'jh-pr-trust' }, t('proposal.trustNote')) : null,
    pending && view.projectHooks.length
      ? h('div', { className: 'jh-approval-status jh-pr-hooks', 'data-tone': 'warn', role: 'alert' }, t('proposal.hooksWarning', { files: view.projectHooks.join(', ') }))
      : null,
    showOutput
      ? field(
          t('proposal.output'),
          h(
            'div',
            null,
            h('pre', { className: 'jh-code jh-pr-output' }, view.output || t('proposal.outputEmpty')),
            h(
              'div',
              { className: 'jh-approval-hint' },
              view.exitCode !== null && view.exitCode !== undefined ? t('proposal.exitCode', { code: view.exitCode }) : '',
              view.exitCode !== null && view.exitCode !== undefined && view.outputTruncated ? ' - ' : '',
              view.outputTruncated ? t('proposal.outputTruncated') : ''
            )
          )
        )
      : null,
    pending ? h('div', { id: `${titleId}-hint`, className: 'jh-approval-hint' }, t('proposal.clickOnly')) : null
    ),
    h(
      'div',
      { className: 'jh-approval-statuses' },
      item.sending ? h('div', { className: 'jh-approval-status', role: 'status' }, t('proposal.sending')) : null,
      view.statusLine
        ? h('div', { className: 'jh-approval-status', 'data-tone': view.state === 'failed' ? 'error' : undefined, role: view.state === 'failed' ? 'alert' : 'status' }, view.statusLine)
        : null,
      item.failure ? h('div', { className: 'jh-approval-status', 'data-tone': 'error', role: 'alert' }, t('proposal.requestFailed', { reason: item.failure })) : null,
      notice ? h('div', { className: 'jh-approval-status', 'data-tone': 'error', role: 'alert' }, notice) : null
    ),
    buttons.length
      ? h(
          'div',
          { className: 'jh-approval-actions' },
          buttons.map(b =>
            h(
              'button',
              {
                key: b.kind,
                ref: b.kind === 'deny' || b.kind === 'stop' ? denyRef : undefined,
                type: 'button',
                className: b.primary ? 'jh-btn jh-btn-deny jh-btn-big' : 'jh-btn jh-btn-allow jh-btn-big',
                disabled: b.disabled || (b.kind === 'run' && !armed),
                'aria-describedby': b.kind === 'run' ? `${titleId}-hint` : undefined,
                onClick: b.kind === 'run' ? onRun : onDeny
              },
              t(LABEL[b.kind])
            )
          )
        )
      : null
  )
}

/** The cards that need a click, newest last, plus the ones that just finished. */
export function ProposalList({ t, max = MAX_PENDING, notes = false }) {
  const state = useProposalsState()
  const now = useNow()
  const items = visibleItems(state.items, now, max)
  if (items.length === 0) {
    if (!notes) return null
    if (state.status === 'unavailable') return h('p', { className: 'jh-faint jh-pr-note' }, t('proposal.unavailable'))
    if (state.status === 'error') return h('p', { className: 'jh-faint jh-pr-note' }, t('proposal.loadError', { reason: state.error || '-' }))
    return null
  }
  return h(
    'div',
    { className: 'jh-approvals jh-card-scroll', 'aria-live': 'assertive' },
    items.map((item, i) => h(ProposalCard, { key: item.id, item, t, now, autoFocus: i === items.length - 1 }))
  )
}
