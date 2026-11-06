import { describe, expect, it, vi } from 'vitest'

import { buildGraph, graphInitial, graphReduce, mergeRoutes, normalizeProfiles } from '../../src/model/graph.js'
import { createGraphController, graphEventTypes, toGraphActions } from '../../src/model/graph-controller.js'
import { createStore } from '../../src/model/store.js'

const NOW = 1_700_000_000_000

function setup({ responses = {}, profiles, routes } = {}) {
  const store = createStore(graphReduce, graphInitial())
  const calls = []
  const request = vi.fn(async (method, params) => {
    calls.push([method, params])
    const r = responses[method]
    if (r instanceof Error) throw r
    if (typeof r === 'function') return r(params)
    if (r === undefined) throw new Error(`no handler for ${method}`)
    return r
  })
  const ctl = createGraphController({
    getState: store.getState,
    dispatch: store.dispatch,
    request,
    listProfiles: profiles ?? (async () => ({ profiles: [{ name: 'default', is_default: true }, { name: 'writer' }] })),
    profileRoutes: routes ?? (async () => [{ connectionId: 'local', mode: 'local', profile: 'default', targetProfile: 'default' }]),
    focusedSession: () => 'sess-1',
    now: () => NOW
  })
  return { store, ctl, calls, request }
}

const active = [{ subagent_id: 'a1', parent_id: null, goal: 'g1', status: 'running', model: 'm', tool_count: 2, owner_agent_session_id: 'sess-1', started_at: NOW / 1000 - 5 }]

describe('events to actions', () => {
  it('watches the subagent events and the wake', () => {
    expect(graphEventTypes).toEqual(expect.arrayContaining(['subagent.spawn_requested', 'subagent.start', 'subagent.thinking', 'subagent.tool', 'subagent.progress', 'subagent.complete', 'wake.detected']))
  })

  it('maps a subagent event, a wake with its profile, and a turn to a session node', () => {
    expect(toGraphActions({ type: 'subagent.start', session_id: 's', payload: { subagent_id: 'x' } }, NOW)[0]).toMatchObject({ type: 'graph.subagent', id: 'x' })
    expect(toGraphActions({ type: 'wake.detected', payload: { phrase: 'hey hermes', profile: 'writer', start_new_session: false } }, NOW)).toEqual([{ type: 'graph.wake', profile: 'writer', at: NOW }])
    expect(toGraphActions({ type: 'wake.detected', payload: { phrase: 'hey hermes' } }, NOW)).toEqual([{ type: 'graph.wake', profile: '', at: NOW }])
    expect(toGraphActions({ type: 'message.start', session_id: 's1', payload: {} }, NOW, { profile: 'writer' })).toEqual([{ type: 'graph.session', id: 's1', profile: 'writer', phase: 'thinking', at: NOW }])
    expect(toGraphActions({ type: 'message.complete', session_id: 's1', payload: {} }, NOW, { profile: 'writer' })).toEqual([{ type: 'graph.session', id: 's1', profile: 'writer', phase: 'idle', at: NOW }])
  })

  it('ignores replayed frames, garbage and unrelated events', () => {
    expect(toGraphActions({ type: 'subagent.start', replayed: true, payload: { subagent_id: 'x' } }, NOW)).toEqual([])
    expect(toGraphActions(null, NOW)).toEqual([])
    expect(toGraphActions({ type: 'subagent.start', payload: null }, NOW)).toEqual([])
    expect(toGraphActions({ type: 'tool.start', payload: {} }, NOW)).toEqual([])
  })
})

describe('mergeRoutes', () => {
  it('adds profiles that only a route knows, marks them remote, and tags the local ones', () => {
    const base = normalizeProfiles({ profiles: [{ name: 'default', is_default: true }] })
    const merged = mergeRoutes(base, [
      { connectionId: 'local', mode: 'local', profile: 'default', targetProfile: 'default' },
      { connectionId: 'spark', mode: 'remote', profile: 'bot', targetProfile: 'bot' }
    ])
    expect(merged.map(p => p.name)).toEqual(['default', 'bot'])
    expect(merged[1]).toMatchObject({ remote: true, connection: 'spark' })
    expect(merged[0].remote).toBe(false)
  })

  it('ignores bad rows', () => {
    expect(mergeRoutes([], [null, 5, { targetProfile: '' }]).length).toBe(0)
    expect(mergeRoutes([], null)).toEqual([])
  })
})

describe('refresh', () => {
  it('loads profiles, the active delegation tree and the focused session', async () => {
    const s = setup({
      responses: {
        'delegation.status': { active, paused: false, max_spawn_depth: 2, max_concurrent_children: 3 },
        'subagent.list': { subagents: [{ subagent_id: 'a2', parent_id: 'a1', goal: 'g2', status: 'queued' }], delegations: [] },
        'spawn_tree.list': { entries: [] }
      }
    })
    const out = await s.ctl.refresh()
    expect(out.ok).toBe(true)
    const st = s.store.getState()
    expect(st.profiles.map(p => p.name)).toEqual(['default', 'writer'])
    expect(Object.keys(st.agents).sort()).toEqual(['a1', 'a2'])
    expect(st.agents.a1.status).toBe('running')
    expect(s.calls.find(c => c[0] === 'subagent.list')[1]).toEqual({ session_id: 'sess-1' })
    const g = buildGraph(st, { now: NOW })
    expect(g.nodes.some(n => n.id === 'a:a1')).toBe(true)
  })

  it('an agent that is not in delegation.status any more is no longer running', async () => {
    const s = setup({ responses: { 'delegation.status': { active, paused: false, max_spawn_depth: 2, max_concurrent_children: 3 }, 'subagent.list': { subagents: [] }, 'spawn_tree.list': { entries: [] } } })
    await s.ctl.refresh()
    s.request.mockImplementation(async method => (method === 'delegation.status' ? { active: [], paused: false, max_spawn_depth: 2, max_concurrent_children: 3 } : method === 'subagent.list' ? { subagents: [] } : { entries: [] }))
    await s.ctl.refresh()
    expect(s.store.getState().agents.a1.status).toBe('unknown')
  })

  it('a failed delegation.status leaves the running agents alone (it proves nothing)', async () => {
    const s = setup({ responses: { 'delegation.status': { active, paused: false, max_spawn_depth: 2, max_concurrent_children: 3 }, 'subagent.list': { subagents: [] }, 'spawn_tree.list': { entries: [] } } })
    await s.ctl.refresh()
    s.request.mockImplementation(async () => { throw new Error('socket closed') })
    await s.ctl.refresh()
    expect(s.store.getState().agents.a1.status).toBe('running')
  })

  it('survives garbage replies', async () => {
    const s = setup({ responses: { 'delegation.status': 'nope', 'subagent.list': null, 'spawn_tree.list': 5 }, profiles: async () => null, routes: async () => { throw new Error('no routes') } })
    const out = await s.ctl.refresh()
    expect(out.ok).toBe(false)
    expect(s.store.getState().agents).toEqual({})
  })

  it('loads the newest saved tree once as history', async () => {
    const s = setup({
      responses: {
        'delegation.status': { active: [], paused: false, max_spawn_depth: 2, max_concurrent_children: 3 },
        'subagent.list': { subagents: [] },
        'spawn_tree.list': { entries: [{ path: 'E:/x/a.json', finished_at: 5 }, { path: 'E:/x/b.json', finished_at: 4 }] },
        'spawn_tree.load': { session_id: 's', subagents: [{ id: 'h1', goal: 'old', status: 'completed' }, { id: 'h2', parentId: 'h1', status: 'running' }] }
      }
    })
    await s.ctl.refresh()
    await s.ctl.refresh()
    expect(s.calls.filter(c => c[0] === 'spawn_tree.load')).toHaveLength(1)
    expect(s.calls.find(c => c[0] === 'spawn_tree.load')[1]).toEqual({ path: 'E:/x/a.json' })
    expect(s.store.getState().agents.h1.status).toBe('completed')
    expect(s.store.getState().agents.h2.status).toBe('unknown')
  })

  it('does not run two refreshes at once', async () => {
    let release
    const gate = new Promise(r => { release = r })
    const s = setup({ responses: { 'delegation.status': async () => { await gate; return { active: [], paused: false, max_spawn_depth: 2, max_concurrent_children: 3 } }, 'subagent.list': { subagents: [] }, 'spawn_tree.list': { entries: [] } } })
    const a = s.ctl.refresh()
    const b = await s.ctl.refresh()
    expect(b).toEqual({ ok: false, reason: 'busy' })
    release()
    expect((await a).ok).toBe(true)
  })
})

describe('connection changes', () => {
  it('a drop marks running agents stale; coming back refreshes and clears them', async () => {
    const s = setup({ responses: { 'delegation.status': { active, paused: false, max_spawn_depth: 2, max_concurrent_children: 3 }, 'subagent.list': { subagents: [] }, 'spawn_tree.list': { entries: [] } } })
    await s.ctl.refresh()
    s.ctl.connection('closed')
    expect(s.store.getState().agents.a1.stale).toBe(true)
    await s.ctl.connection('open')
    expect(s.store.getState().agents.a1.stale).toBe(false)
  })

  it('does not call the gateway while it is closed', async () => {
    const s = setup()
    s.ctl.connection('closed')
    expect(await s.ctl.refresh()).toEqual({ ok: false, reason: 'offline' })
    expect(s.request).not.toHaveBeenCalled()
  })
})
