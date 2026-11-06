// The chat card for `::reactor-session{ref="..."}`. The model writes the directive, so
// every attribute is untrusted: the ref must look like an opaque handle, and what is shown
// comes from the live session list (never from the attribute text).

import { isValidRef, matchRef, rowView } from '../model/agents.js'
import { useAgentsFeed } from './AgentsPanel.js'
import { h } from './h.js'
import { getRuntime, useAgentsState, useNow, useT } from './hooks.js'

export function SessionCard({ attrs, sessionId }) {
  const rt = getRuntime()
  const { t } = useT()
  const agents = useAgentsState()
  const now = useNow()
  useAgentsFeed()

  const ref = attrs && typeof attrs.ref === 'string' ? attrs.ref : ''
  if (!isValidRef(ref)) {
    return h('div', { className: 'jh-root jh-card jh-muted' }, t('directive.invalid'))
  }
  if (agents.status === 'loading' && agents.rows.length === 0) {
    return h('div', { className: 'jh-root jh-card jh-muted', role: 'status' }, t('directive.loading'))
  }
  const row = matchRef(ref, agents.rows)
  if (!row) {
    return h('div', { className: 'jh-root jh-card jh-muted' }, t('directive.missing'))
  }
  const view = rowView(row, now, t)
  return h(
    'div',
    { className: 'jh-root jh-card' },
    h('div', { className: 'jh-row-top' }, h('span', { className: 'jh-agent', 'data-source': view.source }, view.agent), h('span', { className: 'jh-row-title' }, view.title)),
    h(
      'div',
      { className: 'jh-row-meta' },
      h('span', null, view.folder),
      h('span', null, view.age),
      h('span', null, view.turns),
      view.maybeActive ? h('span', { className: 'jh-active', title: t('agents.maybeActiveHint') }, t('agents.maybeActive')) : null
    ),
    h('div', { className: 'jh-card-actions' }, h('button', { type: 'button', className: 'jh-btn jh-btn-sm', onClick: () => void rt.briefSession(row, t, sessionId ?? null) }, t('agents.brief')))
  )
}
