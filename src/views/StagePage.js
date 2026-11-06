// The full page: the big reactor, what Hermes is doing, approvals, activity, and the
// agents list. Also the pane (smaller) and the status bar item.

import { useEffect, useState } from 'react'

import { REACTOR_STATES, selectError, selectHeard, selectReactorState } from '../model/state.js'
import { AgentsPanel } from './AgentsPanel.js'
import { ApprovalList } from './ApprovalCard.js'
import { AskList } from './AskCard.js'
import { GraphPanel } from './GraphView.js'
import { ProposalList } from './ProposalCard.js'
import { Reactor } from './Reactor.js'
import { KanbanLine, NameEditor } from './StageExtras.js'
import { h } from './h.js'
import { getRuntime, useAppState, useAsksState, useAssistantState, useNow, useProposalsState, useT, useUiState } from './hooks.js'
import { waitingCount as asksWaiting } from '../model/asks.js'
import { waitingCount } from '../model/proposals.js'

const PREVIEWABLE = REACTOR_STATES

const FEED_KEY = {
  wake: 'feed.wake',
  listening: 'feed.listening',
  transcribing: 'feed.transcribing',
  transcript: 'feed.transcript',
  interrupted: 'feed.interrupted',
  thinking: 'feed.thinking',
  responding: 'feed.responding',
  done: 'feed.done',
  error: 'feed.error',
  approvalAsked: 'feed.approvalAsked',
  approvalSettled: 'feed.approvalSettled',
  approvalCancelled: 'feed.approvalCancelled',
  approvalAnswered: 'feed.approvalAnswered'
}

function clockTime(ms, locale) {
  try {
    return new Date(ms).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return ''
  }
}

/** The state to draw and the facts around it. */
export function useReactorView(previewState = null) {
  const app = useAppState()
  const now = useNow()
  const { t, locale } = useT()
  const live = selectReactorState(app, now)
  const state = previewState ?? live
  return { app, now, t, locale, live, state, heard: selectHeard(app, now), error: selectError(app, now) }
}

function LanguageSwitch({ t, preference }) {
  const rt = getRuntime()
  const options = [
    ['auto', t('stage.langAuto')],
    ['en', 'EN'],
    ['pt-BR', 'PT']
  ]
  return h(
    'div',
    { className: 'jh-seg', role: 'group', 'aria-label': t('stage.language') },
    options.map(([id, label]) => h('button', { key: id, type: 'button', 'aria-pressed': String(preference === id), onClick: () => rt.localePref.set(id) }, label))
  )
}

function Activity({ feed, t, locale }) {
  return h(
    'section',
    { className: 'jh-feed-section' },
    h('h3', { className: 'jh-section-title' }, t('stage.activity')),
    feed.length === 0
      ? h('div', { className: 'jh-faint' }, t('stage.activityEmpty'))
      : h(
          'ul',
          { className: 'jh-feed' },
          [...feed].reverse().map(item =>
            h('li', { key: item.id, 'data-kind': item.kind }, h('time', null, clockTime(item.at, locale)), h('span', null, t(FEED_KEY[item.kind] ?? 'feed.done')))
          )
        )
  )
}

/** The continue-session cards, with their own title when there are any. */
function ProposalSection({ t }) {
  const { items } = useProposalsState()
  if (items.length === 0) return null
  return h('section', null, h('h3', { className: 'jh-section-title' }, t('proposal.section')), h(ProposalList, { t }))
}

/** The ask-another-profile cards, with their own title when there are any. */
function AskSection({ t }) {
  const { items } = useAsksState()
  if (items.length === 0) return null
  return h('section', null, h('h3', { className: 'jh-section-title' }, t('ask.section')), h(AskList, { t }))
}

/** A quiet line when the backend cannot be reached or refuses this window (nothing to show otherwise). */
function ProposalNotes({ t }) {
  const { items } = useProposalsState()
  return items.length === 0 ? h(ProposalList, { t, notes: true }) : null
}

const VIEWS = ['reactor', 'graph', 'agents']

/** Reactor | Graph | Agents: one segmented control, one view at a time, so the page never needs to scroll. */
function ViewTabs({ view, onPick, t }) {
  return h(
    'div',
    { className: 'jh-tabs', role: 'tablist', 'aria-label': t('stage.views') },
    VIEWS.map(id =>
      h('button', { key: id, type: 'button', role: 'tab', id: `jh-tab-${id}`, 'aria-selected': String(view === id), 'aria-controls': 'jh-stage-view', tabIndex: view === id ? 0 : -1, onClick: () => onPick(id) }, t(`stage.view.${id}`))
    )
  )
}

export function StagePage() {
  const [preview, setPreview] = useState(null)
  const [pick, setPick] = useState('reactor')
  const ui = useUiState()
  // reactor_show("graph") asks for the graph view. Only the runtime may ask, and it does not while a card is pending.
  useEffect(() => {
    if (ui.focus === 'graph') setPick('graph')
  }, [ui.focus, ui.at])
  const view = useReactorView(preview)
  const { app, t, locale, state, heard } = view
  const { preference } = useT()
  const { name: assistantName } = useAssistantState()
  const proposals = useProposalsState()
  const asks = useAsksState()
  const gatewayKey = app.host.gateway === 'open' ? 'gateway.open' : app.host.gateway === 'connecting' ? 'gateway.connecting' : 'gateway.idle'
  const paused = app.host.gateway !== 'open'
  const anyCard = app.approvals.length > 0 || proposals.items.length > 0 || asks.items.length > 0

  return h(
    'div',
    { className: 'jh-root jh-page jh-dark jh-tint', 'data-state': state, 'data-view': pick },
    h(
      'header',
      { className: 'jh-page-head' },
      h('span', { className: 'jh-brand', 'data-testid': 'assistant-name' }, assistantName),
      h(ViewTabs, { view: pick, onPick: setPick, t }),
      h(
        'div',
        { className: 'jh-head-right' },
        h('span', { className: 'jh-chip jh-tint', 'data-state': app.host.gateway === 'open' ? 'responding' : 'offline', 'data-on': 'true' }, h('span', { className: 'jh-dot' }), `${t('stage.gateway')}: ${t(gatewayKey)}`),
        h(LanguageSwitch, { t, preference })
      )
    ),
    // A card that needs a click comes first, above whichever view is open, and keeps its buttons in view.
    anyCard
      ? h(
          'div',
          { className: 'jh-stage-cards' },
          // Hermes approvals first (a turn is blocked on them), then asks, then continues.
          app.approvals.length > 0 ? h('section', null, h('h3', { className: 'jh-section-title' }, t('stage.pending')), h(ApprovalList, { cards: app.approvals, t, paused })) : null,
          h(AskSection, { t }),
          h(ProposalSection, { t })
        )
      : null,
    h(
      'div',
      { className: 'jh-stage-view', id: 'jh-stage-view', role: 'tabpanel', 'aria-labelledby': `jh-tab-${pick}` },
      pick === 'graph' ? h(GraphPanel, { t }) : null,
      pick === 'agents' ? h('div', { className: 'jh-stage-agents' }, h(AgentsPanel, null)) : null,
      pick === 'reactor'
        ? h(
            'div',
            { className: 'jh-stage-layout' },
            h(
              'div',
              { className: 'jh-stage-hero' },
            h(Reactor, { state, label: t(`state.${state}`) }),
            h(
              'div',
              { className: 'jh-caption', 'aria-live': 'polite' },
              h('p', { className: 'jh-state-label' }, t(`state.${state}`)),
              h('p', { className: 'jh-state-hint' }, view.error && state === 'error' && view.error.message ? view.error.message : t(`hint.${state}`)),
              heard && !preview ? h('p', { className: 'jh-heard', 'data-final': String(heard.final) }, h('span', { className: 'jh-heard-label' }, t('stage.heard')), heard.text) : null
            ),
            h('p', { className: 'jh-note' }, t('stage.noAudioMeter'))
            ),
            h(
            'aside',
            { className: 'jh-stage-aside', 'aria-label': t('stage.activity') },
            h(ProposalNotes, { t }),
            h(KanbanLine, { t }),
            h(NameEditor, { t }),
            h(
              'div',
              { className: 'jh-preview' },
              h(
                'details',
                null,
                h('summary', null, t('stage.preview')),
                h(
                  'div',
                  { className: 'jh-preview', style: { marginTop: 8 } },
                  PREVIEWABLE.map(s => h('button', { key: s, type: 'button', className: 'jh-btn jh-btn-sm', 'aria-pressed': String(preview === s), onClick: () => setPreview(preview === s ? null : s) }, t(`state.${s}`))),
                  preview ? h('button', { type: 'button', className: 'jh-linkbtn', onClick: () => setPreview(null) }, t('stage.previewOff')) : null
                )
              )
            ),
            h(Activity, { feed: app.feed, t, locale })
            )
          )
        : null
    )
  )
}

/** The "Reactor" pane: a compact reactor, the state and any approval cards. */
export function ReactorPane() {
  const view = useReactorView()
  const { app, t, state } = view
  const rt = getRuntime()
  const { name: assistantName } = useAssistantState()
  return h(
    'div',
    { className: 'jh-root jh-pane jh-tint', 'data-state': state },
    h(
      'div',
      { className: 'jh-pane-head' },
      h(Reactor, { state, size: 84, label: t(`state.${state}`) }),
      h('div', { style: { minWidth: 0 } }, h('p', { className: 'jh-brand-line' }, assistantName), h('p', { className: 'jh-state-label' }, t(`state.${state}`)), h('div', { className: 'jh-muted' }, t(`hint.${state}`))),
      h('button', { type: 'button', className: 'jh-linkbtn', onClick: () => rt.openStage(), title: t('status.open'), 'aria-label': t('status.open') }, '↗')
    ),
    app.approvals.length > 0 ? h(ApprovalList, { cards: app.approvals, t, paused: app.host.gateway !== 'open' }) : null,
    h(AskList, { t }),
    h(ProposalList, { t })
  )
}

/** The "Agents" pane: Claude Code and Codex sessions on this machine. */
export function AgentsPane() {
  const { state } = useReactorView()
  return h('div', { className: 'jh-root jh-pane jh-tint', 'data-state': state }, h(AgentsPanel, { compact: true }))
}

/** The status bar item: mini reactor, state, pending count. Opens the page. */
export function StatusItem() {
  const { app, t, state, now } = useReactorView()
  const rt = getRuntime()
  const proposals = useProposalsState()
  const asks = useAsksState()
  const pending = app.approvals.length + waitingCount(proposals, now) + asksWaiting(asks, now)
  return h(
    'button',
    { type: 'button', className: 'jh-root jh-status jh-tint', 'data-state': state, onClick: () => rt.openStage(), title: t('status.open'), 'aria-label': `${t('status.label', { state: t(`state.${state}`) })}. ${t('status.open')}` },
    h(Reactor, { state, detail: 'mini', size: 16, label: '' }),
    h('span', null, t(`state.${state}`)),
    pending > 0 ? h('span', { className: 'jh-badge', 'aria-label': t('status.pending', { n: pending }) }, pending) : null
  )
}
