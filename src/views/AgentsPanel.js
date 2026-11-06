// Agents panel: Claude Code and Codex sessions found by Hermes. Handles loading, empty,
// error and gateway-disconnected states. Every title and folder is untrusted text and is
// rendered as text only (React escapes it; nothing here uses innerHTML).

import { useEffect, useState } from 'react'

import { formatAge, panelKind } from '../model/agents.js'
import { h } from './h.js'
import { getRuntime, useAgentsState, useAppState, useNow, useT } from './hooks.js'

function Row({ row, t, onBrief }) {
  return h(
    'li',
    { key: row.id },
    h(
      'button',
      { type: 'button', className: 'jh-row', onClick: () => onBrief(row.id), title: `${t('agents.brief')}${row.folderPath ? ` - ${row.folderPath}` : ''}` },
      h(
        'div',
        { className: 'jh-row-top' },
        h('span', { className: 'jh-agent', 'data-source': row.source }, row.agent),
        h('span', { className: 'jh-row-title' }, row.title)
      ),
      h(
        'div',
        { className: 'jh-row-meta' },
        h('span', null, row.folder),
        h('span', null, row.age),
        h('span', null, row.turns),
        row.maybeActive ? h('span', { className: 'jh-active', title: t('agents.maybeActiveHint') }, t('agents.maybeActive')) : null
      )
    )
  )
}

/** Keeps the list fresh while at least one panel (or card) is on screen. */
export function useAgentsFeed() {
  useEffect(() => getRuntime().retainAgents(), [])
}

export function AgentsPanel({ compact = false }) {
  const rt = getRuntime()
  const { t } = useT()
  const app = useAppState()
  const agents = useAgentsState()
  const now = useNow()
  const [source, setSource] = useState('all')
  const [query, setQuery] = useState('')
  useAgentsFeed()

  const view = panelKind(agents, app.host.gateway, { source, query }, now, t)
  const byId = new Map(agents.rows.map(r => [r.id, r]))
  const onBrief = id => {
    const row = byId.get(id)
    if (row) void rt.briefSession(row, t)
  }

  const filters = [
    ['all', 'agents.filterAll'],
    ['claude', 'agents.filterClaude'],
    ['codex', 'agents.filterCodex']
  ]

  let body
  if (view.kind === 'disconnected') {
    body = h('div', { className: 'jh-state-box', role: 'status' }, t('agents.disconnected'))
  } else if (view.kind === 'loading') {
    body = h('div', { role: 'status', 'aria-label': t('agents.loading'), className: 'jh-rows' }, [0, 1, 2].map(i => h('div', { key: i, className: 'jh-skel' })), h('span', { className: 'jh-sr' }, t('agents.loading')))
  } else if (view.kind === 'error') {
    body = h(
      'div',
      { className: 'jh-state-box', 'data-tone': 'error', role: 'alert' },
      h('div', null, t('agents.error')),
      agents.error ? h('div', { className: 'jh-faint' }, agents.error) : null,
      h('button', { type: 'button', className: 'jh-btn jh-btn-sm', onClick: () => void rt.refreshAgents() }, t('agents.retry'))
    )
  } else if (view.kind === 'empty') {
    body = h('div', { className: 'jh-state-box', role: 'status' }, t('agents.empty'))
  } else if (view.kind === 'emptyFiltered') {
    body = h('div', { className: 'jh-state-box', role: 'status' }, t('agents.emptyFiltered'))
  } else {
    body = h('ul', { className: 'jh-rows' }, view.rows.map(row => h(Row, { key: row.id, row, t, onBrief })))
  }

  const updated = agents.updatedAt ? t('agents.updated', { age: formatAge(agents.updatedAt, now, t) }) : ''

  return h(
    'section',
    { className: 'jh-agents', 'aria-label': t('agents.title') },
    h(
      'h3',
      { className: 'jh-section-title' },
      t('agents.title'),
      h('span', { className: 'jh-faint', style: { textTransform: 'none', letterSpacing: 0, fontWeight: 400 } }, updated),
      h('button', { type: 'button', className: 'jh-linkbtn', style: { marginLeft: 'auto' }, onClick: () => void rt.refreshAgents(), disabled: app.host.gateway !== 'open' }, t('agents.refresh'))
    ),
    compact ? null : h('div', { className: 'jh-muted' }, t('agents.subtitle')),
    h(
      'div',
      { className: 'jh-agents-bar' },
      h('div', { className: 'jh-seg', role: 'group', 'aria-label': t('agents.title') }, filters.map(([id, key]) => h('button', { key: id, type: 'button', 'aria-pressed': String(source === id), onClick: () => setSource(id) }, t(key)))),
      h('input', { className: 'jh-input', type: 'search', value: query, placeholder: t('agents.search'), 'aria-label': t('agents.search'), maxLength: 80, onChange: e => setQuery(e.target.value) })
    ),
    view.staleError ? h('div', { className: 'jh-state-box', 'data-tone': 'error', role: 'alert' }, t('agents.error'), ' ', agents.error) : null,
    body,
    agents.unreadable > 0 ? h('div', { className: 'jh-faint' }, t('agents.unreadable', { n: agents.unreadable })) : null
  )
}
