// Final review round. Ported from the review proofs (show_flood.mjs, proto.mjs): the screen flood guard,
// prototype-safe id maps, the ask list, the anti-misclick delay, the approval banner and the layout contracts.

import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ARM_MS, createArmGate, layoutChanged } from '../../src/model/arming.js'
import { MAX_PENDING, normalizeAsk } from '../../src/model/asks.js'
import { buildGraph, graphInitial, graphReduce, normalizeProfiles } from '../../src/model/graph.js'
import { kanbanInitial, kanbanReduce, badgeFor, toKanbanAction } from '../../src/model/kanban.js'
import { makeT } from '../../src/model/i18n.js'
import { classifyCommand } from '../../src/model/risk.js'
import { MIN_GAP_MS, createShowController } from '../../src/model/screens.js'
import { initialState } from '../../src/model/state.js'
import { AskCard, AskList } from '../../src/views/AskCard.js'
import { ApprovalList } from '../../src/views/ApprovalCard.js'
import { ProposalCard } from '../../src/views/ProposalCard.js'
import { GraphPanel } from '../../src/views/GraphView.js'
import { StagePage } from '../../src/views/StagePage.js'
import { h } from '../../src/views/h.js'
import { CSS } from '../../src/styles.js'
import { fakeRuntime } from './helpers.js'

const NOW = 1_700_000_000_000
const t = makeT('en')
const render = element => renderToStaticMarkup(element)
const ID = n => `ask-${String(n).padStart(20, '0')}`

// ---- 1. reactor_show: one navigation per 3 seconds, none over a pending card ------------------------------------------

function showSetup({ pending = () => false, start = 1000 } = {}) {
  let at = start
  const calls = { nav: 0, focus: 0, notices: [] }
  const c = createShowController({
    navigate: () => {
      calls.nav += 1
    },
    runAction: () => ({ ok: true }),
    pluginEnabled: () => true,
    focusGraph: () => {
      calls.focus += 1
    },
    notify: n => calls.notices.push(n),
    t: k => k,
    cardsPending: pending,
    now: () => at
  })
  return { c, calls, tick: ms => (at += ms) }
}

describe('show flood guard', () => {
  it('200 alternating calls in 2 seconds of fake time open one screen (proof show_flood.mjs)', () => {
    const { c, tick } = showSetup()
    const views = ['stage', 'graph', 'agents', 'profiles', 'cron', 'messaging', 'capabilities']
    let accepted = 0
    for (let i = 0; i < 200; i += 1) {
      tick(10)
      if (c.show(views[i % views.length]).ok) accepted += 1
    }
    expect(accepted).toBe(1)
  })

  it('is one global window, for every view, that opens again after 3 seconds', () => {
    expect(MIN_GAP_MS).toBe(3000)
    const { c, tick } = showSetup()
    expect(c.show('graph').ok).toBe(true)
    tick(2999)
    expect(c.show('agents')).toEqual({ ok: false, reason: 'rate_limited' })
    tick(1)
    expect(c.show('agents').ok).toBe(true)
  })

  it('refuses events while an approval, a proposal or an ask is pending, and says why', () => {
    let pending = true
    const { c, calls, tick } = showSetup({ pending: () => pending })
    expect(c.showFromEvent({ payload: { view: 'graph' } })).toEqual({ ok: false, reason: 'card_pending' })
    expect(c.show('stage')).toEqual({ ok: false, reason: 'card_pending' })
    expect(calls.nav).toBe(0)
    expect(calls.focus).toBe(0)
    pending = false
    tick(10)
    expect(c.showFromEvent({ payload: { view: 'graph' } }).ok).toBe(true)
    expect(calls.nav).toBe(1)
  })

  it('a person clicking the chat button is not throttled and may leave a card', () => {
    const { c, tick } = showSetup({ pending: () => true })
    expect(c.show('graph', { byUser: true }).ok).toBe(true)
    tick(100)
    expect(c.show('agents', { byUser: true }).ok).toBe(true)
  })

  it('a refused call does not move the window', () => {
    const { c, tick } = showSetup()
    c.show('graph')
    tick(2000)
    c.show('agents')
    tick(1000)
    expect(c.show('agents').ok).toBe(true)
  })

  it('the runtime wires the guard to the real approval, proposal and ask stores', () => {
    const { rt } = fakeRuntime()
    expect(rt.hasPendingCard()).toBe(false)
    rt.store.dispatch({ type: 'approval.request', sessionId: 's1', requestId: 'r1', command: 'make x', choices: ['once', 'deny'], at: NOW })
    expect(rt.hasPendingCard()).toBe(true)
    expect(rt.show.show('graph')).toEqual({ ok: false, reason: 'card_pending' })
    rt.focusGraphView()
    expect(rt.ui.getState().focus).toBe('')
  })

  it('a pending ask holds the screen too', () => {
    const { rt } = fakeRuntime()
    rt.asks.dispatch({ type: 'asks.ok', items: [normalizeAsk({ id: ID(1), profile: 'writer', state: 'pending', remaining_s: 200, message: 'hi' }, NOW)], at: NOW })
    expect(rt.hasPendingCard()).toBe(true)
    expect(rt.show.showFromEvent({ payload: { view: 'graph' } }).reason).toBe('card_pending')
  })
})

// ---- 4. id-keyed objects ----------------------------------------------------------------------------------------------

const HOSTILE = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']

describe('hostile ids', () => {
  it('the proof proto.mjs: __proto__ is an agent like any other (and nothing leaks through the chain)', () => {
    let s = graphInitial()
    s = graphReduce(s, { type: 'graph.snapshot', authoritative: false, at: 1000, agents: [{ id: 'real', parentId: null, goal: 'g', status: 'running', sessionId: '' }, { id: '__proto__', parentId: null, goal: 'x', status: 'running', sessionId: '' }] })
    expect(Object.keys(s.agents).sort()).toEqual(['__proto__', 'real'])
    expect(Object.getPrototypeOf(s.agents)).toBeNull()
    expect(s.agents.goal).toBeUndefined()
    const g = buildGraph(s, { now: 2000 })
    expect(g.nodes.map(n => n.id).sort()).toEqual(['a:__proto__', 'a:real', 'reactor'])
  })

  it.each(HOSTILE)('agent %s is stored, completed and pruned as a normal id', id => {
    let s = graphInitial()
    s = graphReduce(s, { type: 'graph.subagent', id, phase: 'start', at: 1000, goal: 'g', parentId: null, sessionId: '' })
    expect(Object.keys(s.agents)).toEqual([id])
    expect(s.agents[id].goal).toBe('g')
    s = graphReduce(s, { type: 'graph.subagent', id, phase: 'complete', status: 'completed', at: 2000 })
    expect(s.agents[id].status).toBe('completed')
    expect(Object.getPrototypeOf(s.agents)).toBeNull()
    s = graphReduce(s, { type: 'graph.disconnect' })
    s = graphReduce(s, { type: 'graph.prune', now: 2000 + 31 * 60_000 })
    expect(Object.keys(s.agents)).toEqual([])
    expect(Object.getPrototypeOf(s.sessions)).toBeNull()
  })

  it.each(HOSTILE)('a missing agent is not found through the chain when the id is %s', id => {
    const s = graphInitial()
    expect(graphReduce(s, { type: 'graph.select', id: `a:${id}` })).toBe(s)
    expect(graphReduce(s, { type: 'graph.select', id: `s:${id}` })).toBe(s)
  })

  it.each(HOSTILE)('session %s is kept apart from the prototype', id => {
    let s = graphInitial()
    s = graphReduce(s, { type: 'graph.session', id, profile: 'p', phase: 'running', at: 1000 })
    expect(Object.keys(s.sessions)).toEqual([id])
    expect(Object.getPrototypeOf(s.sessions)).toBeNull()
  })

  it('a phase named like an Object method is not a status', () => {
    let s = graphInitial()
    s = graphReduce(s, { type: 'graph.subagent', id: 'x', phase: 'constructor', at: 1000, goal: '', parentId: null, sessionId: '' })
    expect(s.agents.x.status).toBe('unknown')
  })

  it('the 300 agent cap and the session cap keep prototype-less maps', () => {
    let s = graphInitial()
    for (let i = 0; i < 305; i += 1) s = graphReduce(s, { type: 'graph.subagent', id: `a${i}`, phase: 'complete', status: 'completed', at: 1000 + i, goal: '', parentId: null, sessionId: '' })
    expect(Object.keys(s.agents)).toHaveLength(300)
    expect(Object.getPrototypeOf(s.agents)).toBeNull()
    for (let i = 0; i < 45; i += 1) s = graphReduce(s, { type: 'graph.session', id: `s${i}`, profile: '', phase: 'running', at: 1000 + i * 2000 })
    expect(Object.keys(s.sessions)).toHaveLength(40)
    expect(Object.getPrototypeOf(s.sessions)).toBeNull()
  })

  it.each(HOSTILE)('kanban task %s has no badge until it is seen, and is then its own entry', id => {
    let s = kanbanInitial()
    expect(badgeFor(s, { id })).toBeNull()
    s = kanbanReduce(s, toKanbanAction({ type: 'plugin.hermes-reactor.kanban.claimed', payload: { task_id: id, assignee: 'w' } }, NOW))
    expect(Object.keys(s.tasks)).toEqual([id])
    expect(badgeFor(s, { id }).label).toContain('working')
    expect(Object.getPrototypeOf(s.tasks)).toBeNull()
  })

  it('a locale or state named like an Object method falls back instead of throwing', () => {
    const s = kanbanReduce(kanbanInitial(), toKanbanAction({ type: 'plugin.hermes-reactor.kanban.claimed', payload: { task_id: 't1' } }, NOW))
    expect(badgeFor(s, { id: 't1' }, 'constructor').label).toBe('Reactor: working')
    expect(makeT('constructor')('stage.activity')).toBe(makeT('en')('stage.activity'))
    expect(makeT('en')('constructor')).toBe('constructor')
  })

  it('the host session map never reads through the chain', () => {
    const s = initialState()
    expect(Object.getPrototypeOf(s.sessions)).toBeNull()
    expect(s.sessions.constructor).toBeUndefined()
  })

  it('a command named like an Object method is not a known read-only program', () => {
    for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(classifyCommand(`${name} --help`).level).not.toBe('safe')
    }
  })

  it('the model code has no plain-object map left that is keyed by an id', () => {
    for (const file of ['graph.js', 'kanban.js', 'state.js']) {
      const text = readFileSync(new URL(`../../src/model/${file}`, import.meta.url), 'utf8')
      expect(text, file).not.toMatch(/(?:agents|sessions|tasks)\s*[:=]\s*\{\s*\}/)
      expect(text, file).not.toMatch(/Object\.fromEntries/)
      expect(text, file).not.toMatch(/\{\s*\.\.\.state\.(agents|sessions|tasks)\s*[,}]/)
    }
  })
})

// ---- 5. asks, approvals and proposals: every pending card is drawn, in a scrolling list ----------------------------

function pendingAsks(n, extra = {}) {
  return Array.from({ length: n }, (_, i) => normalizeAsk({ id: ID(i + 1), profile: 'writer', state: 'pending', remaining_s: 280, message: `message number ${i + 1}`, approvals: { status: 'on', mode: 'manual' }, written_by: 'assistant', ...extra }, NOW))
}

describe('card lists', () => {
  it('MAX_PENDING is the backend cap of five', () => {
    expect(MAX_PENDING).toBe(5)
    const py = readFileSync(new URL('../../reactor_hermes/asks.py', import.meta.url), 'utf8')
    expect(/^MAX_PENDING = (\d+)/m.exec(py)[1]).toBe(String(MAX_PENDING))
  })

  it('AskList draws all five pending asks (it used to cut at four) inside a scrolling list', () => {
    const { rt } = fakeRuntime()
    rt.asks.dispatch({ type: 'asks.ok', items: pendingAsks(5), at: NOW })
    const html = render(h(AskList, { t }))
    for (let i = 1; i <= 5; i += 1) expect(html).toContain(`message number ${i}`)
    expect(html).toContain('jh-card-scroll')
  })

  it('pending asks win over finished ones when the list is full', () => {
    const { rt } = fakeRuntime()
    const done = Array.from({ length: 3 }, (_, i) => ({ ...pendingAsks(1)[0], id: ID(50 + i), message: `old reply ${i}`, state: 'released', phase: 'replied', reply: 'r' }))
    rt.asks.dispatch({ type: 'asks.ok', items: pendingAsks(5), at: NOW })
    for (const d of done) rt.asks.dispatch({ type: 'ask.update', item: d })
    const html = render(h(AskList, { t }))
    for (let i = 1; i <= 5; i += 1) expect(html).toContain(`message number ${i}`)
  })

  it('a pending ask is drawn before a finished one, whatever order they arrived in', () => {
    const { rt } = fakeRuntime()
    const old = { ...pendingAsks(1)[0], id: ID(60), message: 'old finished one', state: 'released', phase: 'replied', reply: 'r' }
    rt.asks.dispatch({ type: 'ask.update', item: old })
    rt.asks.dispatch({ type: 'asks.ok', items: pendingAsks(1), at: NOW })
    const html = render(h(AskList, { t }))
    expect(html.indexOf('message number 1')).toBeGreaterThan(-1)
    expect(html.indexOf('message number 1')).toBeLessThan(html.indexOf('old finished one'))
  })

  it('cards keep their natural height inside the scrolling list instead of being squeezed', () => {
    expect(CSS).toMatch(/\.jh-card-scroll > \.jh-approval\s*\{[^}]*flex:\s*none/)
  })

  it('ApprovalList draws every approval, not the first four', () => {
    const { rt } = fakeRuntime()
    for (let i = 0; i < 6; i += 1) rt.store.dispatch({ type: 'approval.request', sessionId: 's1', requestId: `r${i}`, command: `make target${i}`, choices: ['once', 'deny'], at: NOW })
    const html = render(h(ApprovalList, { cards: rt.store.getState().approvals, t, paused: false }))
    for (let i = 0; i < 6; i += 1) expect(html).toContain(`make target${i}`)
    expect(html).toContain('jh-card-scroll')
  })
})

// ---- 3. the ask card -------------------------------------------------------------------------------------------------

describe('ask card', () => {
  const card = extra => {
    const { rt } = fakeRuntime()
    const item = pendingAsks(1, extra)[0]
    rt.asks.dispatch({ type: 'asks.ok', items: [item], at: NOW })
    return render(h(AskCard, { item, t, now: NOW }))
  }

  it('says the assistant wrote the text and shows the provenance line as part of the message', () => {
    const html = card({ message: '[Sent through Reactor from another profile. The assistant there wrote the text below.]\n\nWrite a tagline.' })
    expect(html).toContain('Written by the assistant')
    expect(html).toContain('Sent through Reactor from another profile')
    expect(html).toContain('Write a tagline.')
  })

  it('shows a red banner when the target profile has approvals off', () => {
    const html = card({ approvals: { status: 'off', mode: 'off' } })
    expect(html).toContain('jh-ask-banner')
    expect(html).toContain('data-tone="danger"')
    expect(html).toMatch(/approvals are OFF/i)
  })

  it('says it could not verify when the setting could not be read', () => {
    const html = card({ approvals: { status: 'unverified', mode: '' } })
    expect(html).toContain('Could not verify')
    expect(html).toContain('data-tone="warn"')
  })

  it('shows no banner when approvals are on', () => {
    expect(card({ approvals: { status: 'on', mode: 'manual' } })).not.toContain('jh-ask-banner')
  })

  it('a missing or bad approvals field counts as unverified, never as on', () => {
    expect(normalizeAsk({ id: ID(9), profile: 'writer', state: 'pending', remaining_s: 10, message: 'x' }, NOW).approvals).toBe('unverified')
    expect(normalizeAsk({ id: ID(9), profile: 'writer', state: 'pending', remaining_s: 10, message: 'x', approvals: { status: 'constructor' } }, NOW).approvals).toBe('unverified')
    expect(normalizeAsk({ id: ID(9), profile: 'writer', state: 'pending', remaining_s: 10, message: 'x', approvals: { status: 'off' } }, NOW).approvals).toBe('off')
  })

  it('the old always-true own-tools claim is not read from the backend any more', () => {
    const src = readFileSync(new URL('../../src/model/asks.js', import.meta.url), 'utf8')
    expect(src).not.toContain('profile_has_own_tools')
  })
})

// ---- 2. anti-misclick ----------------------------------------------------------------------------------------------

describe('arming gate', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const gate = () => {
    const seen = []
    const g = createArmGate({ onChange: v => seen.push(v) })
    return { g, seen }
  }

  it('is off for 700 ms after the card appears', () => {
    expect(ARM_MS).toBe(700)
    const { g } = gate()
    g.touch('card-1')
    expect(g.armed()).toBe(false)
    vi.advanceTimersByTime(699)
    expect(g.armed()).toBe(false)
    vi.advanceTimersByTime(1)
    expect(g.armed()).toBe(true)
  })

  it('goes off again for 700 ms when the content changes, not when it stays the same', () => {
    const { g } = gate()
    g.touch('a')
    vi.advanceTimersByTime(700)
    g.touch('a')
    expect(g.armed()).toBe(true)
    g.touch('a, longer')
    expect(g.armed()).toBe(false)
    vi.advanceTimersByTime(650)
    g.touch('a, longer, more')
    vi.advanceTimersByTime(650)
    expect(g.armed()).toBe(false)
    vi.advanceTimersByTime(50)
    expect(g.armed()).toBe(true)
  })

  it('a layout change counts as a change, small jitter does not', () => {
    expect(layoutChanged(200, 201)).toBe(false)
    expect(layoutChanged(200, 230)).toBe(true)
    expect(layoutChanged(null, 230)).toBe(false)
    const { g } = gate()
    g.touch('a')
    vi.advanceTimersByTime(700)
    g.layout(200)
    g.layout(201)
    expect(g.armed()).toBe(true)
    g.layout(260)
    expect(g.armed()).toBe(false)
  })

  it('dispose cancels the timer', () => {
    const { g, seen } = gate()
    g.touch('a')
    g.dispose()
    vi.advanceTimersByTime(2000)
    expect(seen).toEqual([])
  })
})

describe('buttons start disabled', () => {
  it('Run, Send and Approve are disabled on first draw; Deny never is', () => {
    const { rt } = fakeRuntime()
    const ask = pendingAsks(1)[0]
    const askHtml = render(h(AskCard, { item: ask, t, now: NOW }))
    expect(/<button[^>]*disabled=""[^>]*>Send</.test(askHtml)).toBe(true)
    expect(/<button[^>]*disabled=""[^>]*>Deny</.test(askHtml)).toBe(false)

    rt.store.dispatch({ type: 'approval.request', sessionId: 's1', requestId: 'r1', command: 'make x', choices: ['once', 'session', 'deny'], at: NOW })
    const list = render(h(ApprovalList, { cards: rt.store.getState().approvals, t, paused: false }))
    expect(/<button[^>]*disabled=""[^>]*>Approve once</.test(list) || /<button[^>]*disabled=""[^>]*>Allow once</.test(list)).toBe(true)
    expect(/<button[^>]*disabled=""[^>]*>Deny</.test(list)).toBe(false)

    const proposal = { id: 'pr-0000000000000001', label: 'p-1', agent: 'claude', title: 'T', folder: 'F', instruction: 'do it', instructionFits: true, instructionHidden: 0, projectHooks: [], state: 'pending', code: '', started: false, remainingS: 200, receivedAt: NOW, startedAt: null, endedAt: null, exitCode: null, output: '', outputTruncated: false, sending: '', failure: '' }
    const prHtml = render(h(ProposalCard, { item: proposal, t, now: NOW }))
    expect(/<button[^>]*disabled=""[^>]*>Run</.test(prHtml)).toBe(true)
    expect(/<button[^>]*disabled=""[^>]*>Deny</.test(prHtml)).toBe(false)
  })
})

// ---- 8. sticky action footers and the layout contracts ----------------------------------------------------------------

describe('layout', () => {
  it('a card scrolls its content and keeps its buttons in a sticky footer', () => {
    expect(CSS).toMatch(/\.jh-approval-actions\s*\{[^}]*position:\s*sticky[^}]*bottom:\s*0/)
    expect(CSS).toMatch(/\.jh-card-scroll\s*\{[^}]*overflow-y:\s*auto/)
    expect(CSS).toMatch(/\.jh-approval\s*\{[^}]*max-height/)
    expect(CSS).toMatch(/\.jh-approval-body\s*\{[^}]*overflow-y:\s*auto/)
  })

  it('every card keeps its actions outside the scrolling body', () => {
    const { rt } = fakeRuntime()
    rt.store.dispatch({ type: 'approval.request', sessionId: 's1', requestId: 'r1', command: 'make x', choices: ['once', 'deny'], at: NOW })
    const html = render(h(ApprovalList, { cards: rt.store.getState().approvals, t, paused: false }))
    expect(html.indexOf('jh-approval-body')).toBeGreaterThan(-1)
    expect(html.indexOf('jh-approval-body')).toBeLessThan(html.indexOf('jh-approval-actions'))
    const ask = render(h(AskCard, { item: pendingAsks(1)[0], t, now: NOW }))
    expect(ask.indexOf('jh-approval-body')).toBeLessThan(ask.indexOf('jh-approval-actions'))
  })

  it('the stage has a Reactor | Graph | Agents control and shows the reactor first', () => {
    fakeRuntime()
    const html = render(h(StagePage, null))
    expect(html).toContain('role="tablist"')
    const tabs = [...html.matchAll(/role="tab"[^>]*>([^<]*)</g)].map(m => m[1])
    expect(tabs).toEqual(['Reactor', 'Graph', 'Agents'])
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('jh-stage-hero')
  })

  it('a pending card is rendered above the view, in its own layer', () => {
    const { rt } = fakeRuntime()
    rt.asks.dispatch({ type: 'asks.ok', items: pendingAsks(1), at: NOW })
    const html = render(h(StagePage, null))
    expect(html.indexOf('class="jh-stage-cards"')).toBeGreaterThan(-1)
    expect(html.indexOf('class="jh-stage-cards"')).toBeLessThan(html.indexOf('class="jh-stage-view"'))
  })

  it('Hermes approvals come first in the card layer, before asks and continues', () => {
    const { rt } = fakeRuntime()
    rt.asks.dispatch({ type: 'asks.ok', items: pendingAsks(1), at: NOW })
    rt.store.dispatch({ type: 'approval.request', sessionId: 's1', requestId: 'r1', command: 'make x', choices: ['once', 'deny'], at: NOW })
    const html = render(h(StagePage, null))
    expect(html.indexOf('Hermes needs your decision')).toBeGreaterThan(-1)
    expect(html.indexOf('Hermes needs your decision')).toBeLessThan(html.indexOf('Reactor wants to send a message'))
  })

  it('the page does not scroll: it fills its box and the views scroll inside it', () => {
    expect(CSS).toMatch(/\.jh-page\s*\{[^}]*overflow:\s*hidden/)
  })

  it('the graph detail sits beside the canvas and never over the nodes', () => {
    expect(CSS).not.toMatch(/\.jh-graph-detail\[data-open='true'\]\s*\{[^}]*position:\s*absolute/)
    expect(CSS).toMatch(/\.jh-graph-body\s*\{[^}]*display:\s*grid/)
  })

  it('the graph centre carries the reactor artwork', () => {
    const { rt } = fakeRuntime()
    rt.graph.dispatch({ type: 'graph.profiles', at: NOW, profiles: normalizeProfiles({ profiles: [{ name: 'default', is_default: true }] }) })
    const html = render(h(GraphPanel, { t }))
    expect(html).toContain('jh-gart')
    const centre = html.slice(html.indexOf('data-kind="reactor"'), html.indexOf('data-kind="profile"'))
    expect(centre).toContain('<foreignObject')
    expect(centre).toContain('jh-reactor jh-stage')
  })
})
