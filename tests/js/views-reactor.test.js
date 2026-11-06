import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { normalizeAsk } from '../../src/model/asks.js'
import { agentFromEvent, normalizeProfiles } from '../../src/model/graph.js'
import { makeT } from '../../src/model/i18n.js'
import { AskCard } from '../../src/views/AskCard.js'
import { GraphPanel, NodeDetail } from '../../src/views/GraphView.js'
import { ShowCard } from '../../src/views/ShowCard.js'
import { KanbanLine, NameEditor } from '../../src/views/StageExtras.js'
import { StagePage } from '../../src/views/StagePage.js'
import { h } from '../../src/views/h.js'
import { fakeRuntime } from './helpers.js'

const NOW = 1_700_000_000_000
const render = element => renderToStaticMarkup(element)
const t = makeT('en')
const ev = (type, payload, sid = 's1') => agentFromEvent({ type, session_id: sid, payload }, NOW)

function withGraph() {
  const { rt } = fakeRuntime()
  rt.graph.dispatch({ type: 'graph.profiles', at: NOW, profiles: normalizeProfiles({ profiles: [{ name: 'default', is_default: true }, { name: 'writer' }, { name: 'coder' }] }) })
  rt.graph.dispatch(ev('subagent.start', { subagent_id: 'sa-1', goal: 'find the bug', model: 'm1' }))
  rt.graph.dispatch(ev('subagent.start', { subagent_id: 'sa-2', parent_id: 'sa-1', goal: 'child', model: 'm1' }))
  rt.graph.dispatch(ev('subagent.complete', { subagent_id: 'sa-2', status: 'completed' }))
  return rt
}

describe('GraphPanel', () => {
  it('draws the reactor, the profiles and the agents with their status', () => {
    withGraph()
    const html = render(h(GraphPanel, { t }))
    expect(html).toContain('data-kind="reactor"')
    expect(html.match(/data-kind="profile"/g)).toHaveLength(3)
    expect(html.match(/data-kind="agent"/g)).toHaveLength(2)
    expect(html).toContain('data-status="running"')
    expect(html).toContain('data-status="completed"')
    expect(html).toContain('role="button"')
    expect(html).toContain('Select a node.')
  })

  it('the center carries the assistant name', () => {
    const rt = withGraph()
    rt.assistant.dispatch({ type: 'assistant.set', name: 'Orion', synced: true })
    expect(render(h(GraphPanel, { t }))).toContain('>Orion<')
  })

  it('shows the empty hint with nothing to draw', () => {
    fakeRuntime()
    expect(render(h(GraphPanel, { t }))).toContain('No subagents yet')
  })

  it('a selected node shows its details as text', () => {
    const rt = withGraph()
    rt.selectNode('a:sa-1')
    const html = render(h(GraphPanel, { t }))
    expect(html).toContain('find the bug')
    expect(html).toContain('m1')
    expect(html).toContain('aria-pressed="true"')
  })

  it('escapes hostile goal text', () => {
    const { rt } = fakeRuntime()
    rt.graph.dispatch(ev('subagent.start', { subagent_id: 'x', goal: '<img src=x onerror=alert(1)>' }))
    rt.selectNode('a:x')
    const html = render(h(GraphPanel, { t }))
    expect(html).not.toContain('<img')
  })

  it('says the connection dropped', () => {
    const rt = withGraph()
    rt.graph.dispatch({ type: 'graph.disconnect', at: NOW })
    expect(render(h(GraphPanel, { t }))).toContain('The connection dropped')
  })

  it('NodeDetail copes with null', () => {
    expect(render(h(NodeDetail, { detail: null, t }))).toContain('Select a node.')
  })
})

describe('StagePage', () => {
  it('shows the chosen assistant name in the header and holds the graph, the name editor', () => {
    const { rt } = fakeRuntime()
    rt.assistant.dispatch({ type: 'assistant.set', name: 'Friday', synced: true })
    const html = render(h(StagePage, null))
    expect(html).toContain('data-testid="assistant-name">Friday<')
    expect(html).toContain('role="tablist"')
    expect(html).toContain('Assistant name: Friday')
  })
})

describe('NameEditor', () => {
  it('offers Hermes and Jarbas presets only', () => {
    fakeRuntime()
    const html = render(h(NameEditor, { t }))
    expect(html).toContain('>Hermes<')
    expect(html).toContain('>Jarbas<')
    expect(html.toLowerCase()).not.toContain('jarvis')
  })
})

describe('KanbanLine', () => {
  it('is empty until a task was seen, then shows the latest change read only', () => {
    const { rt } = fakeRuntime()
    expect(render(h(KanbanLine, { t }))).toBe('')
    rt.kanban.dispatch({ type: 'kanban.event', kind: 'claimed', taskId: 't_abc', assignee: 'writer', profile: 'default', board: 'main', at: rt.now() })
    const html = render(h(KanbanLine, { t }))
    expect(html).toContain('Task t_abc claimed by writer')
    expect(html).toContain('Working 1')
  })
})

describe('AskCard', () => {
  const raw = (over = {}) => ({ id: 'AbCdEfGhIjKlMnOpQrStUvWx', label: 'pa-1', profile: 'writer', message: 'Write a tagline.', state: 'pending', remaining_s: 280, ...over })
  const buttons = html => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(m => m[1])

  it('names the profile, shows the exact message and the warning, Deny first', () => {
    fakeRuntime()
    const item = normalizeAsk(raw(), NOW)
    const html = render(h(AskCard, { item, t, now: NOW }))
    expect(html).toContain('writer')
    expect(html).toContain('Write a tagline.')
    expect(html).toContain('own tools')
    expect(buttons(html)).toEqual(['Deny', 'Send'])
    expect(html).toContain('Only a real click on Send sends it')
  })

  it('a message it cannot show whole turns Send off', () => {
    fakeRuntime()
    const item = normalizeAsk(raw({ message: 'a‮b' }), NOW)
    const html = render(h(AskCard, { item, t, now: NOW }))
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Send<\/button>/)
  })

  it('shows the reply as text on the card after it came back', () => {
    fakeRuntime()
    const item = { ...normalizeAsk(raw({ state: 'released', message: 'Hi' }), NOW), phase: 'replied', reply: '<b>bold</b> words' }
    const html = render(h(AskCard, { item, t, now: NOW }))
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt; words')
    expect(html).toContain('untrusted text')
  })

  it('an expired card has no Send', () => {
    fakeRuntime()
    const item = normalizeAsk(raw({ remaining_s: 1 }), NOW)
    expect(buttons(render(h(AskCard, { item, t, now: NOW + 10_000 })))).not.toContain('Send')
  })
})

describe('ShowCard', () => {
  it('a valid view renders a button and navigates only on click (render alone does nothing)', () => {
    const { rt } = fakeRuntime()
    let navigated = 0
    rt.show.show = () => { navigated += 1 }
    const html = render(h(ShowCard, { attrs: { view: 'graph' } }))
    expect(html).toContain('Open the live agent graph')
    expect(navigated).toBe(0)
  })

  it('an unknown or missing view is a quiet error card', () => {
    fakeRuntime()
    expect(render(h(ShowCard, { attrs: { view: 'settings' } }))).toContain('could not read')
    expect(render(h(ShowCard, { attrs: {} }))).toContain('could not read')
    expect(render(h(ShowCard, { attrs: null }))).toContain('could not read')
  })
})
