import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { normalizeList } from '../../src/model/agents.js'
import { REACTOR_STATES } from '../../src/model/state.js'
import { AgentsPanel } from '../../src/views/AgentsPanel.js'
import { ApprovalCard } from '../../src/views/ApprovalCard.js'
import { Reactor } from '../../src/views/Reactor.js'
import { SessionCard } from '../../src/views/SessionCard.js'
import { StagePage, StatusItem } from '../../src/views/StagePage.js'
import { h } from '../../src/views/h.js'
import { makeT } from '../../src/model/i18n.js'
import { fakeRuntime } from './helpers.js'

const NOW = 1_700_000_000_000
const row = (over = {}) => ({ id: 'a'.repeat(64), source: 'claude', label: 'Claude Code', title: 'Fix auth', cwd: '/work/api', mtime: NOW / 1000 - 3600, turn_count: 5, ...over })
const render = element => renderToStaticMarkup(element)
const t = makeT('en')

describe('Reactor', () => {
  it('renders every state with its data-state and an accessible label', () => {
    for (const state of REACTOR_STATES) {
      const html = render(h(Reactor, { state, label: state }))
      expect(html).toContain(`data-state="${state}"`)
      expect(html).toContain('role="img"')
    }
  })
  it('has no audio meter: no level, bars, canvas or analyser', () => {
    const html = render(h(Reactor, { state: 'listening' })).toLowerCase()
    expect(html).not.toMatch(/canvas|analyser|meter|amplitude|volume|level/)
  })
  it('renders the mini version for the status bar', () => {
    const html = render(h(Reactor, { state: 'thinking', detail: 'mini', size: 16 }))
    expect(html).toContain('jh-mini')
    expect(html).toContain('width:16px')
  })
  it('gives two reactors distinct gradient ids', () => {
    const html = render(h('div', null, h(Reactor, { state: 'idle' }), h(Reactor, { state: 'idle' })))
    const ids = [...html.matchAll(/id="(jh-cg-[^"]+)"/g)].map(m => m[1])
    expect(new Set(ids).size).toBe(2)
  })
})

describe('ApprovalCard', () => {
  function card(command, choices = ['once', 'session', 'always', 'deny']) {
    const { rt } = fakeRuntime()
    rt.store.dispatch({ type: 'approval.request', sessionId: 's1', requestId: 'r1', command, description: 'why', choices, at: NOW })
    return rt.store.getState().approvals[0]
  }
  const buttonLabels = html => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(m => m[1])

  it('offers Deny first and no "Always" for a destructive command', () => {
    const html = render(h(ApprovalCard, { card: card('rm -rf /'), t }))
    expect(buttonLabels(html)).toEqual(['Deny', 'Allow once'])
    expect(html).toContain('Risky')
  })
  it('offers all four only for a read-only command', () => {
    const html = render(h(ApprovalCard, { card: card('git status'), t }))
    expect(buttonLabels(html)).toEqual(['Deny', 'Allow once', 'Allow for this session', 'Always allow'])
  })
  it('treats an unknown command as unverified and risky, with no "Always"', () => {
    const html = render(h(ApprovalCard, { card: card('make deploy'), t }))
    expect(html).toContain('Unverified')
    expect(html).not.toContain('Always allow')
  })
  it('renders the command as text, never as markup', () => {
    const html = render(h(ApprovalCard, { card: card('echo <img src=x onerror=alert(1)>'), t }))
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })
  it('shows a failure and keeps the buttons', () => {
    const { rt } = fakeRuntime()
    rt.store.dispatch({ type: 'approval.request', sessionId: 's1', requestId: 'r1', command: 'make x', choices: ['once', 'deny'], at: NOW })
    rt.store.dispatch({ type: 'approval.failed', key: 's1::r1', reason: 'timed out' })
    const html = render(h(ApprovalCard, { card: rt.store.getState().approvals[0], t }))
    expect(html).toContain('did not go through: timed out')
    expect(html).toContain('Nothing was approved')
    // Deny stays usable; Allow is only held back by the 700 ms anti-misclick delay, which a first draw always has.
    expect(/<button[^>]*disabled=""[^>]*>Deny</.test(html)).toBe(false)
  })
  it('disables buttons while sending and while the gateway is reconnecting', () => {
    const { rt } = fakeRuntime()
    rt.store.dispatch({ type: 'approval.request', sessionId: 's1', requestId: 'r1', command: 'make x', choices: ['once', 'deny'], at: NOW })
    rt.store.dispatch({ type: 'approval.sending', key: 's1::r1', choice: 'once' })
    const sending = render(h(ApprovalCard, { card: rt.store.getState().approvals[0], t }))
    expect(sending).toContain('disabled')
    expect(sending).toContain('Sending your answer')
    const paused = render(h(ApprovalCard, { card: { ...rt.store.getState().approvals[0], status: 'pending' }, t, paused: true }))
    expect(paused).toContain('Reconnecting')
    expect(paused).toContain('disabled')
  })
  it('explains in Portuguese too', () => {
    const html = render(h(ApprovalCard, { card: card('rm -rf x'), t: makeT('pt-BR') }))
    expect(html).toContain('Negar')
    expect(html).toContain('Permitir uma vez')
    expect(html).not.toContain('Sempre permitir')
  })
})

describe('AgentsPanel states', () => {
  it('loading', () => {
    fakeRuntime()
    const html = render(h(AgentsPanel, null))
    expect(html).toContain('jh-skel')
  })
  it('empty', () => {
    const { rt } = fakeRuntime()
    rt.agents.dispatch({ type: 'agents.ok', list: normalizeList({ sessions: [] }), at: NOW })
    expect(render(h(AgentsPanel, null))).toContain('No Claude Code or Codex sessions found')
  })
  it('error with a retry button', () => {
    const { rt } = fakeRuntime()
    rt.agents.dispatch({ type: 'agents.fail', message: 'Could not read session folders' })
    const html = render(h(AgentsPanel, null))
    expect(html).toContain('Could not list sessions.')
    expect(html).toContain('Could not read session folders')
    expect(html).toContain('Try again')
  })
  it('gateway disconnected', () => {
    const { rt } = fakeRuntime()
    rt.agents.dispatch({ type: 'agents.ok', list: normalizeList({ sessions: [row()] }), at: NOW })
    rt.store.dispatch({ type: 'host', patch: { gateway: 'closed' } })
    const html = render(h(AgentsPanel, null))
    expect(html).toContain('Hermes is not connected')
    expect(html).not.toContain('Fix auth')
  })
  it('list, with hostile titles rendered as inert text', () => {
    const { rt } = fakeRuntime()
    rt.agents.dispatch({ type: 'agents.ok', list: normalizeList({ sessions: [row({ title: '<img src=x onerror=alert(1)>‮ evil' })] }), at: NOW })
    const html = render(h(AgentsPanel, null))
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
    expect(html).not.toContain('‮')
  })
})

describe('SessionCard (chat directive)', () => {
  it('rejects a ref that is not an opaque handle', () => {
    fakeRuntime()
    for (const ref of ['', '../etc/passwd', '<script>x</script>', 'a b', undefined]) {
      expect(render(h(SessionCard, { attrs: { ref }, sessionId: 's1' }))).toContain('could not read this session card')
    }
  })
  it('shows the session from the live list, not text from the attributes', () => {
    const { rt } = fakeRuntime()
    rt.agents.dispatch({ type: 'agents.ok', list: normalizeList({ sessions: [row()] }), at: NOW })
    const html = render(h(SessionCard, { attrs: { ref: 'a'.repeat(64), title: 'INJECTED TITLE' }, sessionId: 's1' }))
    expect(html).toContain('Fix auth')
    expect(html).not.toContain('INJECTED TITLE')
  })
  it('says so when the session is not in the list', () => {
    const { rt } = fakeRuntime()
    rt.agents.dispatch({ type: 'agents.ok', list: normalizeList({ sessions: [row()] }), at: NOW })
    expect(render(h(SessionCard, { attrs: { ref: 'b'.repeat(64) } }))).toContain('not in the current list')
  })
})

describe('StagePage and StatusItem', () => {
  it('shows offline when the gateway is not open', () => {
    const { rt } = fakeRuntime()
    rt.store.dispatch({ type: 'host', patch: { gateway: 'closed' } })
    const html = render(h(StagePage, null))
    expect(html).toContain('data-state="offline"')
    expect(html).toContain('Hermes is offline')
  })
  it('shows the approval state with a pending count in the status item', () => {
    const { rt } = fakeRuntime()
    rt.store.dispatch({ type: 'approval.request', sessionId: 's1', requestId: 'r1', command: 'make x', choices: ['once', 'deny'], at: NOW })
    const html = render(h(StatusItem, null))
    expect(html).toContain('data-state="approval"')
    expect(html).toContain('jh-badge')
  })
  it('never offers a speaking state in the preview list', () => {
    fakeRuntime()
    const html = render(h(StagePage, null))
    expect(html).not.toContain('>Speaking<')
  })
  it('says plainly that it does not measure audio', () => {
    fakeRuntime()
    expect(render(h(StagePage, null))).toContain('does not measure audio')
  })
})
