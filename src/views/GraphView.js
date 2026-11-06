// The live agent graph: plain SVG, no library. Reactor in the middle, profiles around it, the sessions that are doing
// something, and the subagents hanging from their parents. Click (or Enter / Space on the focused node) selects a node and
// the panel beside it shows its goal, model, last tool, tokens and duration.
//
// Everything that came from an agent (goals, tool names, models) is untrusted text and is drawn as text only.

import { useEffect, useMemo, useRef } from 'react'

import { buildGraph, detailFor, layoutGraph } from '../model/graph.js'
import { selectReactorState } from '../model/state.js'
import { Reactor } from './Reactor.js'
import { h } from './h.js'
import { getRuntime, useAppState, useAssistantState, useBox, useGraphState, useNow, useUiState } from './hooks.js'

const FALLBACK = { w: 960, h: 600 } // until the canvas has been measured (and for the server render)
const GLYPH = { queued: '…', running: '', completed: '✓', failed: '✕', error: '✕', timeout: '!', interrupted: '■', unknown: '?' }

function valueOrNone(value, t) {
  return value === null || value === undefined || value === '' ? t('graph.detail.none') : value
}

function Row({ label, children }) {
  return h('div', { className: 'jh-gd-row' }, h('dt', null, label), h('dd', null, children))
}

export function NodeDetail({ detail, t }) {
  if (!detail) return h('p', { className: 'jh-faint' }, t('graph.detail.empty'))
  const rt = getRuntime()
  const status = key => t(`graph.status.${key}`)
  const head = h(
    'div',
    { className: 'jh-gd-head' },
    h('span', { className: 'jh-gd-kind' }, t(`graph.node.${detail.kind}`)),
    h('span', { className: 'jh-gd-title' }, detail.kind === 'reactor' ? t('graph.node.reactor') : detail.title),
    h('button', { type: 'button', className: 'jh-linkbtn', onClick: () => rt.selectNode(null), 'aria-label': t('graph.detail.close') }, '×')
  )
  let rows = []
  if (detail.kind === 'agent') {
    rows = [
      h(Row, { key: 'status', label: t('graph.detail.status') }, `${status(detail.status)}${detail.stale ? ` - ${t('graph.status.unknown')}` : ''}`),
      h(Row, { key: 'goal', label: t('graph.detail.goal') }, valueOrNone(detail.goal, t)),
      h(Row, { key: 'model', label: t('graph.detail.model') }, valueOrNone(detail.model, t)),
      h(Row, { key: 'tool', label: t('graph.detail.tool') }, valueOrNone(detail.tool, t)),
      h(Row, { key: 'tools', label: t('graph.detail.tools') }, valueOrNone(detail.toolCount, t)),
      h(Row, { key: 'tokens', label: t('graph.detail.tokens') }, detail.tokensIn === null && detail.tokensOut === null ? t('graph.detail.none') : t('graph.detail.tokensValue', { input: detail.tokensIn ?? '-', output: detail.tokensOut ?? '-' })),
      h(Row, { key: 'dur', label: t('graph.detail.duration') }, detail.durationS === null ? t('graph.detail.none') : t('graph.detail.seconds', { n: detail.durationS })),
      detail.depth !== null && detail.depth !== undefined ? h(Row, { key: 'depth', label: t('graph.detail.depth') }, detail.depth) : null,
      detail.parentId ? h(Row, { key: 'parent', label: t('graph.detail.parent') }, detail.parentId) : null
    ]
  } else if (detail.kind === 'profile') {
    rows = [
      h(Row, { key: 'model', label: t('graph.detail.model') }, valueOrNone(detail.model, t)),
      h(Row, { key: 'prov', label: t('graph.detail.provider') }, valueOrNone(detail.provider, t))
    ]
  } else if (detail.kind === 'session') {
    rows = [
      h(Row, { key: 'profile', label: t('graph.detail.profile') }, valueOrNone(detail.profile, t)),
      h(Row, { key: 'phase', label: t('graph.detail.phase') }, status(detail.phase || 'idle'))
    ]
  }
  return h('div', null, head, h('dl', { className: 'jh-gd' }, rows), detail.kind === 'agent' ? h('p', { className: 'jh-faint jh-gd-note' }, t('graph.untrusted')) : null)
}

function nodeLabel(node, name, t) {
  if (node.kind === 'reactor') return name
  return node.label
}

function ariaFor(node, name, t) {
  if (node.kind === 'reactor') return `${t('graph.node.reactor')}: ${name}`
  const kind = t(`graph.node.${node.kind}`)
  const status = node.kind === 'agent' ? t(`graph.status.${node.status}`) : node.kind === 'session' ? t(`graph.status.${node.status}`) : node.lit ? t('graph.lit') : ''
  return `${kind} ${node.label}${status ? `: ${status}` : ''}`
}

export function GraphPanel({ t }) {
  const rt = getRuntime()
  const app = useAppState()
  const graph = useGraphState()
  const ui = useUiState()
  const { name } = useAssistantState()
  const now = useNow()
  const sectionRef = useRef(null)
  const canvasRef = useRef(null)
  const { w: W, h: H } = useBox(canvasRef, FALLBACK)
  const second = Math.floor(now / 1000)

  useEffect(() => rt.retainGraph(), [rt])
  useEffect(() => {
    if (ui.focus === 'graph' && sectionRef.current && typeof sectionRef.current.scrollIntoView === 'function') {
      // Never scroll the page while a card waits for a click (the same rule as reactor_show).
      if (!rt.hasPendingCard()) sectionRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      rt.clearFocus()
    }
  }, [ui.focus, ui.at, rt])

  const reactorState = selectReactorState(app, now)
  const model = useMemo(
    () => buildGraph(graph, { now: second * 1000, reactorState }),
    // The graph is a function of the store, the second and the reactor state.
    [graph, second, reactorState]
  )
  const layout = useMemo(() => layoutGraph(model, { width: W, height: H }), [model, W, H])
  const detail = detailFor(graph, graph.selected, now)
  const agentCount = model.nodes.filter(n => n.kind === 'agent').length

  return h(
    'section',
    { ref: sectionRef, className: 'jh-graph', 'data-focus': ui.focus === 'graph' ? 'true' : 'false', 'aria-label': t('graph.title') },
    h('h3', { className: 'jh-section-title' }, t('graph.title'), h('span', { className: 'jh-chip', 'data-on': agentCount > 0 ? 'true' : 'false' }, String(agentCount))),
    h(
      'div',
      { className: 'jh-graph-body' },
      h(
        'div',
        { className: 'jh-graph-canvas', ref: canvasRef },
        h(
          'svg',
          { className: 'jh-gsvg', viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': t('graph.aria'), preserveAspectRatio: 'xMidYMid meet' },
          layout.edges.map(e => h('line', { key: `${e.from}>${e.to}`, className: 'jh-gedge', 'data-status': e.status, x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2 })),
          layout.nodes.map(n =>
            h(
              'g',
              {
                key: n.id,
                className: 'jh-gnode',
                'data-kind': n.kind,
                'data-status': n.status,
                'data-state': n.kind === 'reactor' ? reactorState : undefined,
                'data-lit': String(n.lit),
                'data-stale': String(n.stale),
                'data-selected': String(graph.selected === n.id),
                transform: `translate(${n.x} ${n.y})`,
                role: 'button',
                tabIndex: 0,
                'aria-pressed': String(graph.selected === n.id),
                'aria-label': ariaFor(n, name, t),
                onClick: () => rt.selectNode(graph.selected === n.id ? null : n.id),
                onKeyDown: event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    rt.selectNode(graph.selected === n.id ? null : n.id)
                  }
                }
              },
              h('circle', { className: 'jh-gring', r: n.r + 6 }),
              h('circle', { className: 'jh-gdot', r: n.r }),
              // Hermes is the central node and wears the reactor: the same drawing and the same state as the stage.
              n.kind === 'reactor'
                ? h('foreignObject', { className: 'jh-gart-box jh-gart', x: -n.r, y: -n.r, width: n.r * 2, height: n.r * 2, 'aria-hidden': 'true' }, h(Reactor, { state: reactorState, size: '100%', label: '' }))
                : null,
              n.kind === 'agent' && GLYPH[n.status] ? h('text', { className: 'jh-gglyph', textAnchor: 'middle', dy: '0.35em' }, GLYPH[n.status]) : null,
              h('text', { className: 'jh-glabel', textAnchor: 'middle', y: n.r + 16 }, nodeLabel(n, name, t))
            )
          )
        ),
        agentCount === 0 && layout.nodes.length <= 1 + (graph.profiles.length || 0) ? h('p', { className: 'jh-graph-empty jh-faint' }, t('graph.empty')) : null,
        layout.hidden > 0 ? h('p', { className: 'jh-faint jh-graph-hidden' }, t('graph.hidden', { n: layout.hidden })) : null,
        graph.stale ? h('p', { className: 'jh-faint jh-graph-hidden', role: 'status' }, t('graph.stale')) : null
      ),
      h('div', { className: 'jh-graph-detail', 'aria-live': 'polite', 'data-open': String(Boolean(detail)) }, detail ? h(NodeDetail, { detail, t }) : h('p', { className: 'jh-faint jh-graph-tip' }, t('graph.detail.empty')))
    )
  )
}
