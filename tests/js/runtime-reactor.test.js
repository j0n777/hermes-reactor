import { describe, expect, it, vi } from 'vitest'

import { createRuntime } from '../../src/runtime.js'
import { buildGraph } from '../../src/model/graph.js'
import { SHOW_EVENT } from '../../src/model/screens.js'

function manualAtom(initial) {
  let value = initial
  const subs = new Set()
  return {
    get: () => value,
    subscribe(fn) { subs.add(fn); fn(value); return () => subs.delete(fn) },
    set(next) { value = next; for (const fn of [...subs]) fn(value) }
  }
}

function setup(over = {}) {
  const handlers = new Map()
  const calls = { navigate: [], action: [], rest: [], request: [], kanban: 0, notify: [] }
  const hostState = {
    gateway: manualAtom('open'),
    busy: manualAtom(false),
    awaitingResponse: manualAtom(false),
    focusedSessionId: manualAtom('s1'),
    activeSessionId: manualAtom('s1'),
    focusedSessionProfile: manualAtom('writer')
  }
  const store = new Map()
  const rt = createRuntime({
    request: vi.fn(async (method, params) => {
      calls.request.push(method)
      if (method === 'delegation.status') return { active: [], paused: false, max_spawn_depth: 2, max_concurrent_children: 3 }
      if (method === 'subagent.list') return { subagents: [] }
      if (method === 'spawn_tree.list') return { entries: [] }
      if (method === 'session.foreign.list') return { sessions: [], next_offset: null }
      if (method === 'approval.pending') return { approvals: [] }
      return {}
    }),
    rest: vi.fn(async (path, opts) => {
      calls.rest.push([path, opts?.method ?? 'GET'])
      if (path === '/proposals') return { ok: true, proposals: [] }
      if (path === '/asks') return { ok: true, asks: [] }
      if (path === '/assistant') return { ok: true, name: opts?.body?.name }
      return { ok: true }
    }),
    onEvent: (type, fn) => { handlers.set(type, fn); return () => handlers.delete(type) },
    setTimeout: () => () => {},
    setInterval: () => () => {},
    storage: { get: (k, d) => (store.has(k) ? store.get(k) : d), set: (k, v) => store.set(k, v) },
    hostState,
    notify: n => calls.notify.push(n.kind),
    composer: { insertText: vi.fn(async () => true), focus: vi.fn() },
    navigate: path => calls.navigate.push(path),
    runAction: id => { calls.action.push(id); return { ok: true } },
    pluginEnabled: id => id === 'kanban',
    listProfiles: async () => ({ profiles: [{ name: 'default', is_default: true }, { name: 'writer' }, { name: 'coder' }] }),
    profileRoutes: async () => [],
    requestProfile: vi.fn(async () => ({})),
    onKanbanChange: () => { calls.kanban += 1 },
    now: () => 1_700_000_000_000,
    ...over
  })
  const emit = (type, payload, extra = {}) => handlers.get(type)?.({ type, payload, session_id: 's1', ...extra })
  return { rt, handlers, calls, hostState, emit, store }
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('subagent events reach the graph', () => {
  it('one listener per event type, feeding both the reactor state and the graph', () => {
    const { rt, emit } = setup()
    rt.start()
    emit('subagent.spawn_requested', { subagent_id: 'a', goal: 'g' })
    emit('subagent.start', { subagent_id: 'a', goal: 'g', model: 'm' })
    emit('subagent.tool', { subagent_id: 'a', tool_name: 'terminal' })
    expect(rt.graph.getState().agents.a).toMatchObject({ status: 'running', tool: 'terminal' })
    expect(rt.store.getState().sessions.s1.phase).toBe('thinking') // the reactor state saw it too
  })

  it('a wake lights the profile it names', () => {
    const { rt, emit } = setup()
    rt.start()
    emit('wake.detected', { phrase: 'hey hermes', profile: 'writer', start_new_session: false })
    expect(rt.graph.getState().wake.profile).toBe('writer')
  })

  it('a chat turn adds its session under the focused chat profile', () => {
    const { rt, emit } = setup()
    rt.start()
    emit('message.start', {})
    expect(rt.graph.getState().sessions.s1).toMatchObject({ profile: 'writer', phase: 'thinking' })
  })

  it('a replayed frame is history, not now', () => {
    const { rt, emit } = setup()
    rt.start()
    emit('subagent.start', { subagent_id: 'old' }, { replayed: true })
    expect(rt.graph.getState().agents.old).toBeUndefined()
  })

  it('selecting a node is a runtime call and unknown ids select nothing', () => {
    const { rt, emit } = setup()
    rt.start()
    emit('subagent.start', { subagent_id: 'a' })
    rt.selectNode('a:a')
    expect(rt.graph.getState().selected).toBe('a:a')
    rt.selectNode('a:nope')
    expect(rt.graph.getState().selected).toBeNull()
  })
})

describe('graph refresh on demand', () => {
  it('retainGraph loads profiles and the delegation tree, and the nodes exist', async () => {
    const { rt, calls } = setup()
    rt.start()
    const release = rt.retainGraph()
    for (let i = 0; i < 5; i += 1) await flush()
    expect(calls.request).toContain('delegation.status')
    const g = buildGraph(rt.graph.getState(), { now: 1_700_000_000_000 })
    expect(g.nodes.filter(n => n.kind === 'profile').map(n => n.label)).toEqual(['default', 'writer', 'coder'])
    release()
  })

  it('a dropped gateway marks running agents stale, and coming back clears them', async () => {
    const { rt, emit, hostState } = setup()
    rt.start()
    emit('subagent.start', { subagent_id: 'a' })
    hostState.gateway.set('closed')
    expect(rt.graph.getState().agents.a.stale).toBe(true)
    hostState.gateway.set('open')
    await flush()
    await flush()
    expect(rt.graph.getState().stale).toBe(false)
  })
})

describe('reactor_show', () => {
  it('opens the screen the plugin event names', () => {
    let clock = 1_700_000_000_000
    const { rt, emit, calls } = setup({ now: () => clock })
    rt.start()
    emit(SHOW_EVENT, { view: 'cron' })
    expect(calls.action).toEqual(['nav.cron'])
    emit(SHOW_EVENT, { view: 'stage' })
    expect(calls.navigate).toEqual([]) // one navigation per 3 seconds
    clock += 3000
    emit(SHOW_EVENT, { view: 'stage' })
    expect(calls.navigate).toEqual(['/reactor'])
  })

  it('graph focuses the graph on the stage page', () => {
    const { rt, emit, calls } = setup()
    rt.start()
    emit(SHOW_EVENT, { view: 'graph' })
    expect(calls.navigate).toEqual(['/reactor'])
    expect(rt.ui.getState().focus).toBe('graph')
  })

  it('an unknown view does nothing, kanban off gives a notice', () => {
    const { rt, emit, calls } = setup({ pluginEnabled: () => false })
    rt.start()
    emit(SHOW_EVENT, { view: 'rm -rf' })
    emit(SHOW_EVENT, { view: 'kanban' })
    expect(calls.navigate).toEqual([])
    expect(calls.action).toEqual([])
    expect(calls.notify).toEqual(['warning'])
  })

  it('stop() removes the listener', () => {
    const { rt, handlers } = setup()
    rt.start()
    expect(handlers.has(SHOW_EVENT)).toBe(true)
    rt.stop()
    expect(handlers.has(SHOW_EVENT)).toBe(false)
  })
})

describe('kanban', () => {
  it('keeps worker states and tells the badge hook something changed', () => {
    const { rt, emit, calls } = setup()
    rt.start()
    emit('plugin.hermes-reactor.kanban.claimed', { task_id: 't_1', assignee: 'writer', profile: 'default', board: 'main', run_id: 1 })
    expect(rt.kanban.getState().tasks.t_1.state).toBe('claimed')
    expect(calls.kanban).toBe(1)
  })
})

describe('the assistant name', () => {
  it('is loaded, pushed to the backend on start and again when the gateway comes back', async () => {
    const { rt, calls, hostState, store } = setup()
    store.set('assistantName', 'Orion')
    rt.start()
    await flush()
    expect(rt.assistant.getState().name).toBe('Orion')
    expect(calls.rest.filter(c => c[0] === '/assistant')).toHaveLength(1)
    hostState.gateway.set('closed')
    hostState.gateway.set('open')
    await flush()
    expect(calls.rest.filter(c => c[0] === '/assistant')).toHaveLength(2)
  })

  it('setAssistantName sanitizes and stores', async () => {
    const { rt, store } = setup()
    rt.start()
    await rt.setAssistantName('  Friday!  ')
    expect(rt.assistant.getState().name).toBe('Friday')
    expect(store.get('assistantName')).toBe('Friday')
  })
})

describe('asks', () => {
  it('the ask store and controller exist and refresh reads /asks', async () => {
    const { rt, calls } = setup()
    rt.start()
    await rt.refreshAsks()
    expect(calls.rest.some(c => c[0] === '/asks')).toBe(true)
    expect(rt.asks.getState().status).toBe('empty')
  })
})
