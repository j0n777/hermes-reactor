import { describe, expect, it } from 'vitest'

import {
  ENDED_SHOW_MS,
  MAX_AGENTS,
  MAX_SHOWN,
  agentFromEvent,
  buildGraph,
  detailFor,
  graphInitial,
  graphReduce,
  layoutGraph,
  normalizeProfiles,
  normalizeSubagent,
  subagentEventTypes
} from '../../src/model/graph.js'

const T0 = 1_700_000_000_000

const ev = (type, payload, sessionId = 'sess-1', at = T0) => agentFromEvent({ type, session_id: sessionId, payload }, at)
const apply = (state, ...actions) => actions.reduce((s, a) => (a ? graphReduce(s, a) : s), state)
const profiles = names =>
  normalizeProfiles({ profiles: names.map((n, i) => ({ name: n, is_default: i === 0, model: 'fake-lab-model', provider: 'custom', display_name: '' })) })

describe('subagent events become actions', () => {
  it('knows the six event types', () => {
    expect(subagentEventTypes).toEqual(['subagent.spawn_requested', 'subagent.start', 'subagent.thinking', 'subagent.tool', 'subagent.progress', 'subagent.complete'])
  })

  it('reads the contract fields', () => {
    const a = ev('subagent.start', { subagent_id: 'sa-1', parent_id: null, goal: 'find the bug', model: 'm1', depth: 1, tool_count: 0, task_index: 0, task_count: 1 })
    expect(a).toMatchObject({ type: 'graph.subagent', phase: 'start', id: 'sa-1', parentId: null, goal: 'find the bug', model: 'm1', depth: 1, sessionId: 'sess-1', at: T0 })
  })

  it('falls back to delegation id + task index, then to the child session id, else ignores', () => {
    expect(ev('subagent.start', { delegation_id: 'd9', task_index: 2 }).id).toBe('d9:2')
    expect(ev('subagent.start', { delegation_id: 'd9' }).id).toBe('d9:0')
    expect(ev('subagent.start', { child_session_id: 'child-7' }).id).toBe('child-7')
    expect(ev('subagent.start', { goal: 'no id at all' })).toBeNull()
    expect(ev('subagent.start', null)).toBeNull()
    expect(agentFromEvent(null, T0)).toBeNull()
    expect(agentFromEvent({ type: 'message.delta', payload: { subagent_id: 'x' } }, T0)).toBeNull()
  })

  it('is defensive about types and cleans text', () => {
    const a = ev('subagent.tool', { subagent_id: 'sa‮-1', goal: 'g​o\u0000al'.repeat(200), tool_name: 5, input_tokens: 'many', output_tokens: -3, tool_count: 2.7 })
    expect(a.id).toBe('sa-1')
    expect(a.goal.length).toBeLessThanOrEqual(200)
    expect(a.goal).not.toMatch(/[​\u0000]/)
    expect(a.tool).toBe('')
    expect(a.tokensIn).toBeNull()
    expect(a.tokensOut).toBeNull()
    expect(a.toolCount).toBe(2)
  })

  it('maps the complete status, and unknown words become unknown', () => {
    expect(ev('subagent.complete', { subagent_id: 'a', status: 'failed' }).status).toBe('failed')
    expect(ev('subagent.complete', { subagent_id: 'a', status: 'weird' }).status).toBe('unknown')
    expect(ev('subagent.complete', { subagent_id: 'a' }).status).toBe('completed')
  })
})

describe('normalizing snapshots', () => {
  it('reads delegation.status / subagent.list rows (snake case) and saved trees (camel case)', () => {
    const snake = normalizeSubagent({ subagent_id: 's1', parent_id: 'p', goal: 'g', model: 'm', status: 'running', tool_count: 4, last_tool: 'terminal', started_at: 1_700_000_000, depth: 2, owner_agent_session_id: 'S' })
    expect(snake).toMatchObject({ id: 's1', parentId: 'p', status: 'running', toolCount: 4, tool: 'terminal', startedAt: 1_700_000_000_000, depth: 2, sessionId: 'S' })
    const camel = normalizeSubagent({ id: 'c1', parentId: 'q', goal: 'x', toolCount: 1, startedAt: 1_700_000_000_500, durationSeconds: 3.5, inputTokens: 10, outputTokens: 20, status: 'completed' })
    expect(camel).toMatchObject({ id: 'c1', parentId: 'q', startedAt: 1_700_000_000_500, durationS: 3.5, tokensIn: 10, tokensOut: 20, status: 'completed' })
  })

  it('rejects rows without an id and survives garbage', () => {
    expect(normalizeSubagent({ goal: 'x' })).toBeNull()
    expect(normalizeSubagent(null)).toBeNull()
    expect(normalizeSubagent('str')).toBeNull()
  })

  it('normalizes profiles and tolerates a bad reply', () => {
    const list = profiles(['default', 'writer'])
    expect(list.map(p => p.name)).toEqual(['default', 'writer'])
    expect(list[0].isDefault).toBe(true)
    expect(normalizeProfiles(null)).toEqual([])
    expect(normalizeProfiles({ profiles: [{ name: '' }, { name: 'ok' }, 5] }).map(p => p.name)).toEqual(['ok'])
    expect(normalizeProfiles({ profiles: Array.from({ length: 200 }, (_, i) => ({ name: `p${i}` })) })).toHaveLength(64)
  })
})

describe('the reducer', () => {
  it('builds an agent from spawn_requested, start, tool, complete in order', () => {
    let s = graphInitial()
    s = apply(s, ev('subagent.spawn_requested', { subagent_id: 'a', goal: 'g', task_index: 0 }, 'sess-1', T0))
    expect(s.agents.a.status).toBe('queued')
    s = apply(s, ev('subagent.start', { subagent_id: 'a', model: 'm' }, 'sess-1', T0 + 1000))
    expect(s.agents.a).toMatchObject({ status: 'running', model: 'm', startedAt: T0 + 1000 })
    s = apply(s, ev('subagent.tool', { subagent_id: 'a', tool_name: 'terminal', tool_count: 1 }, 'sess-1', T0 + 2000))
    expect(s.agents.a).toMatchObject({ tool: 'terminal', toolCount: 1 })
    s = apply(s, ev('subagent.complete', { subagent_id: 'a', status: 'completed', duration_seconds: 4.2, input_tokens: 100, output_tokens: 50 }, 'sess-1', T0 + 5000))
    expect(s.agents.a).toMatchObject({ status: 'completed', durationS: 4.2, tokensIn: 100, tokensOut: 50, endedAt: T0 + 5000 })
  })

  it('creates the agent from any event (late first sight) and never regresses a finished one', () => {
    let s = apply(graphInitial(), ev('subagent.tool', { subagent_id: 'late', tool_name: 'x' }))
    expect(s.agents.late.status).toBe('running')
    s = apply(s, ev('subagent.complete', { subagent_id: 'late', status: 'failed' }, 'sess-1', T0 + 10))
    // events that arrive after the end must not bring it back to life
    s = apply(s, ev('subagent.start', { subagent_id: 'late' }, 'sess-1', T0 + 20), ev('subagent.thinking', { subagent_id: 'late' }, 'sess-1', T0 + 30), ev('subagent.tool', { subagent_id: 'late', tool_count: 9 }, 'sess-1', T0 + 40))
    expect(s.agents.late.status).toBe('failed')
    expect(s.agents.late.toolCount).not.toBe(9)
  })

  it('a start never turns running back into queued, and queued does not overwrite running', () => {
    let s = apply(graphInitial(), ev('subagent.start', { subagent_id: 'a' }))
    s = apply(s, ev('subagent.spawn_requested', { subagent_id: 'a', goal: 'late goal' }))
    expect(s.agents.a.status).toBe('running')
    expect(s.agents.a.goal).toBe('late goal')
  })

  it('keeps the parent link, ignores a self parent, and keeps an earlier parent when a later event omits it', () => {
    let s = apply(graphInitial(), ev('subagent.start', { subagent_id: 'c', parent_id: 'p' }))
    s = apply(s, ev('subagent.tool', { subagent_id: 'c', parent_id: null }))
    expect(s.agents.c.parentId).toBe('p')
    s = apply(s, ev('subagent.start', { subagent_id: 'self', parent_id: 'self' }))
    expect(s.agents.self.parentId).toBeNull()
  })

  it('unknown parent ids are fine: the node is drawn under its session', () => {
    const s = apply(graphInitial(), ev('subagent.start', { subagent_id: 'orphan', parent_id: 'never-seen' }))
    const g = buildGraph(s, { now: T0 })
    const node = g.nodes.find(n => n.id === 'a:orphan')
    expect(node).toBeTruthy()
    expect(g.edges.some(e => e.to === 'a:orphan')).toBe(true)
    expect(g.edges.find(e => e.to === 'a:orphan').from).not.toBe('a:never-seen')
  })

  it('caps the stored agents, dropping the oldest finished first and never the running ones', () => {
    let s = graphInitial()
    for (let i = 0; i < MAX_AGENTS + 40; i += 1) {
      s = apply(s, ev('subagent.start', { subagent_id: `x${i}` }, 'sess-1', T0 + i))
      if (i % 2 === 0) s = apply(s, ev('subagent.complete', { subagent_id: `x${i}`, status: 'completed' }, 'sess-1', T0 + i + 1))
    }
    const ids = Object.keys(s.agents)
    expect(ids.length).toBeLessThanOrEqual(MAX_AGENTS)
    const running = ids.filter(id => s.agents[id].status === 'running')
    expect(running.length).toBe((MAX_AGENTS + 40) / 2)
  })

  it('selecting an unknown id selects nothing; a selected node that disappears is cleared', () => {
    let s = apply(graphInitial(), ev('subagent.start', { subagent_id: 'a' }))
    expect(graphReduce(s, { type: 'graph.select', id: 'a:nope' }).selected).toBeNull()
    s = graphReduce(s, { type: 'graph.select', id: 'a:a' })
    expect(s.selected).toBe('a:a')
    s = graphReduce(s, { type: 'graph.prune', now: T0 + 3 * 3_600_000 })
    expect(s.agents.a).toBeDefined() // running agents are never pruned
    s = apply(s, ev('subagent.complete', { subagent_id: 'a', status: 'completed' }, 'sess-1', T0 + 1))
    s = graphReduce(s, { type: 'graph.prune', now: T0 + 3 * 3_600_000 })
    expect(s.agents.a).toBeUndefined()
    expect(s.selected).toBeNull()
  })

  it('same input, same output: a no-op action returns the same state object', () => {
    const s = apply(graphInitial(), ev('subagent.start', { subagent_id: 'a' }))
    expect(graphReduce(s, { type: 'nothing' })).toBe(s)
    expect(graphReduce(s, { type: 'graph.select', id: null })).toBe(s)
  })
})

describe('reconnects and snapshots', () => {
  it('marks running agents stale on disconnect and the snapshot clears it', () => {
    let s = apply(graphInitial(), ev('subagent.start', { subagent_id: 'a' }), ev('subagent.start', { subagent_id: 'b' }))
    s = graphReduce(s, { type: 'graph.disconnect', at: T0 + 5 })
    expect(s.stale).toBe(true)
    expect(s.agents.a.stale).toBe(true)
    s = graphReduce(s, { type: 'graph.snapshot', at: T0 + 9, authoritative: true, agents: [normalizeSubagent({ subagent_id: 'a', status: 'running', goal: 'g' })] })
    expect(s.stale).toBe(false)
    expect(s.agents.a.stale).toBe(false)
    expect(s.agents.a.goal).toBe('g')
    // b was running before the break and is not in the authoritative list: it ended while we were away
    expect(s.agents.b.status).toBe('unknown')
    expect(s.agents.b.stale).toBe(false)
  })

  it('a non authoritative snapshot (one session) only adds and updates', () => {
    let s = apply(graphInitial(), ev('subagent.start', { subagent_id: 'a' }))
    s = graphReduce(s, { type: 'graph.snapshot', at: T0, authoritative: false, agents: [normalizeSubagent({ subagent_id: 'n', status: 'queued' })] })
    expect(s.agents.a.status).toBe('running')
    expect(s.agents.n.status).toBe('queued')
  })

  it('a snapshot can finish an agent, but a running snapshot does not revive a finished one', () => {
    let s = apply(graphInitial(), ev('subagent.start', { subagent_id: 'a' }), ev('subagent.complete', { subagent_id: 'a', status: 'completed' }))
    s = graphReduce(s, { type: 'graph.snapshot', at: T0 + 5, authoritative: true, agents: [normalizeSubagent({ subagent_id: 'a', status: 'running' })] })
    expect(s.agents.a.status).toBe('completed')
    let t = apply(graphInitial(), ev('subagent.start', { subagent_id: 'z' }))
    t = graphReduce(t, { type: 'graph.snapshot', at: T0 + 5, authoritative: false, agents: [normalizeSubagent({ subagent_id: 'z', status: 'timeout' })] })
    expect(t.agents.z.status).toBe('timeout')
  })

  it('loads a saved tree as history, ended', () => {
    const rows = [{ id: 'h1', goal: 'old', status: 'completed', durationSeconds: 2 }, { id: 'h2', parentId: 'h1', goal: 'older', status: 'running' }]
    const s = graphReduce(graphInitial(), { type: 'graph.history', at: T0, agents: rows.map(normalizeSubagent) })
    expect(s.agents.h1.status).toBe('completed')
    expect(s.agents.h2.status).toBe('unknown') // a saved tree is over: nothing in it is still running
    expect(s.agents.h2.parentId).toBe('h1')
  })
})

describe('profiles, sessions and the wake', () => {
  it('shows every profile and lights the one that was woken', () => {
    let s = graphReduce(graphInitial(), { type: 'graph.profiles', at: T0, profiles: profiles(['default', 'writer', 'coder']) })
    s = graphReduce(s, { type: 'graph.wake', profile: 'writer', at: T0 })
    const g = buildGraph(s, { now: T0 + 1000 })
    expect(g.nodes.filter(n => n.kind === 'profile').map(n => n.label)).toEqual(['default', 'writer', 'coder'])
    expect(g.nodes.find(n => n.id === 'p:writer').lit).toBe(true)
    expect(g.nodes.find(n => n.id === 'p:coder').lit).toBe(false)
    expect(buildGraph(s, { now: T0 + 60_000 }).nodes.find(n => n.id === 'p:writer').lit).toBe(false)
  })

  it('a wake with no profile (or an unknown one) lights the default profile', () => {
    let s = graphReduce(graphInitial(), { type: 'graph.profiles', at: T0, profiles: profiles(['default', 'writer']) })
    s = graphReduce(s, { type: 'graph.wake', profile: '', at: T0 })
    expect(buildGraph(s, { now: T0 }).nodes.find(n => n.id === 'p:default').lit).toBe(true)
    s = graphReduce(s, { type: 'graph.wake', profile: 'ghost', at: T0 })
    expect(buildGraph(s, { now: T0 }).nodes.find(n => n.id === 'p:default').lit).toBe(true)
  })

  it('a wake before any profile is known still shows a node', () => {
    const s = graphReduce(graphInitial(), { type: 'graph.wake', profile: 'writer', at: T0 })
    expect(buildGraph(s, { now: T0 }).nodes.find(n => n.id === 'p:writer')?.lit).toBe(true)
  })

  it('draws active sessions under their profile, and agents under their session', () => {
    let s = graphReduce(graphInitial(), { type: 'graph.profiles', at: T0, profiles: profiles(['default', 'writer']) })
    s = graphReduce(s, { type: 'graph.session', id: 'sess-1', profile: 'writer', phase: 'thinking', at: T0 })
    s = apply(s, ev('subagent.start', { subagent_id: 'a', goal: 'g' }, 'sess-1'))
    const g = buildGraph(s, { now: T0 })
    expect(g.edges).toContainEqual(expect.objectContaining({ from: 'p:writer', to: 's:sess-1' }))
    expect(g.edges).toContainEqual(expect.objectContaining({ from: 's:sess-1', to: 'a:a' }))
    expect(g.edges).toContainEqual(expect.objectContaining({ from: 'reactor', to: 'p:writer' }))
  })

  it('an idle old session is not drawn', () => {
    let s = graphReduce(graphInitial(), { type: 'graph.session', id: 'old', profile: 'default', phase: 'idle', at: T0 })
    expect(buildGraph(s, { now: T0 + 10 * 60_000 }).nodes.some(n => n.id === 's:old')).toBe(false)
  })
})

describe('buildGraph', () => {
  it('always has the reactor in the center, even when empty', () => {
    const g = buildGraph(graphInitial(), { now: T0, reactorState: 'thinking' })
    expect(g.nodes).toHaveLength(1)
    expect(g.nodes[0]).toMatchObject({ id: 'reactor', kind: 'reactor', status: 'thinking' })
    expect(g.edges).toEqual([])
    expect(g.hidden).toBe(0)
  })

  it('hides ended agents after a while but keeps running ones', () => {
    let s = apply(graphInitial(), ev('subagent.start', { subagent_id: 'run' }), ev('subagent.start', { subagent_id: 'done' }), ev('subagent.complete', { subagent_id: 'done', status: 'completed' }))
    expect(buildGraph(s, { now: T0 + 1000 }).nodes.some(n => n.id === 'a:done')).toBe(true)
    const later = buildGraph(s, { now: T0 + ENDED_SHOW_MS + 1000 })
    expect(later.nodes.some(n => n.id === 'a:done')).toBe(false)
    expect(later.nodes.some(n => n.id === 'a:run')).toBe(true)
  })

  it('breaks parent cycles instead of looping', () => {
    let s = apply(graphInitial(), ev('subagent.start', { subagent_id: 'a', parent_id: 'b' }), ev('subagent.start', { subagent_id: 'b', parent_id: 'a' }))
    const g = buildGraph(s, { now: T0 })
    expect(g.nodes.filter(n => n.kind === 'agent')).toHaveLength(2)
    expect(g.edges.filter(e => e.to === 'a:a' || e.to === 'a:b').length).toBe(2)
    const lay = layoutGraph(g, { width: 800, height: 600 })
    expect(lay.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true)
  })

  it('shows at most MAX_SHOWN nodes, running first, with ancestors kept and the rest counted', () => {
    let s = graphReduce(graphInitial(), { type: 'graph.profiles', at: T0, profiles: profiles(['default']) })
    for (let i = 0; i < 150; i += 1) {
      s = apply(s, ev('subagent.start', { subagent_id: `r${i}`, parent_id: i % 10 === 0 ? null : `r${i - (i % 10)}` }, 'sess-1', T0 + i))
      if (i % 3 === 0) s = apply(s, ev('subagent.complete', { subagent_id: `r${i}`, status: 'completed' }, 'sess-1', T0 + i + 1))
    }
    const g = buildGraph(s, { now: T0 + 1000 })
    expect(g.nodes.length).toBeLessThanOrEqual(MAX_SHOWN + 1)
    expect(g.hidden).toBeGreaterThan(0)
    const ids = new Set(g.nodes.map(n => n.id))
    for (const e of g.edges) {
      expect(ids.has(e.from)).toBe(true)
      expect(ids.has(e.to)).toBe(true)
    }
    const nodes = g.nodes.filter(n => n.kind === 'agent')
    expect(nodes.some(n => n.status === 'running')).toBe(true)
  })

  it('stale nodes are marked so the view can dim them', () => {
    let s = apply(graphInitial(), ev('subagent.start', { subagent_id: 'a' }))
    s = graphReduce(s, { type: 'graph.disconnect', at: T0 + 1 })
    expect(buildGraph(s, { now: T0 + 2 }).nodes.find(n => n.id === 'a:a').stale).toBe(true)
  })
})

describe('layout', () => {
  const big = () => {
    let s = graphReduce(graphInitial(), { type: 'graph.profiles', at: T0, profiles: profiles(['default', 'a', 'b', 'c', 'd']) })
    for (let i = 0; i < 80; i += 1) s = apply(s, ev('subagent.start', { subagent_id: `n${i}`, parent_id: i > 0 && i % 4 ? `n${i - 1}` : null }, 'sess-1', T0 + i))
    return buildGraph(s, { now: T0 + 100 })
  }

  it('puts the reactor in the middle and everything inside the box, deterministically', () => {
    const g = big()
    const a = layoutGraph(g, { width: 900, height: 600 })
    const b = layoutGraph(g, { width: 900, height: 600 })
    expect(a).toEqual(b)
    const c = a.nodes.find(n => n.id === 'reactor')
    expect(c.x).toBe(450)
    expect(c.y).toBe(300)
    for (const n of a.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(n.r)
      expect(n.x).toBeLessThanOrEqual(900 - n.r)
      expect(n.y).toBeGreaterThanOrEqual(n.r)
      expect(n.y).toBeLessThanOrEqual(600 - n.r)
    }
    expect(a.edges.every(e => Number.isFinite(e.x1 + e.y1 + e.x2 + e.y2))).toBe(true)
  })

  it('does not stack two nodes on the same spot', () => {
    const lay = layoutGraph(big(), { width: 900, height: 600 })
    const seen = new Set(lay.nodes.map(n => `${Math.round(n.x)}:${Math.round(n.y)}`))
    expect(seen.size).toBe(lay.nodes.length)
  })

  it('copes with a tiny box and an empty graph', () => {
    const lay = layoutGraph(buildGraph(graphInitial(), { now: T0 }), { width: 10, height: 10 })
    expect(lay.nodes).toHaveLength(1)
    expect(Number.isFinite(lay.nodes[0].x)).toBe(true)
  })
})

describe('node details', () => {
  it('describes an agent: goal, model, tool, tokens, duration', () => {
    let s = apply(
      graphInitial(),
      ev('subagent.start', { subagent_id: 'a', goal: 'find it', model: 'm1', depth: 1 }, 'sess-1', T0),
      ev('subagent.tool', { subagent_id: 'a', tool_name: 'terminal', tool_count: 3, input_tokens: 10, output_tokens: 4 }, 'sess-1', T0 + 1000)
    )
    const running = detailFor(s, 'a:a', T0 + 7000)
    expect(running).toMatchObject({ kind: 'agent', title: 'a', goal: 'find it', model: 'm1', tool: 'terminal', tokensIn: 10, tokensOut: 4, status: 'running', durationS: 7, toolCount: 3 })
    s = apply(s, ev('subagent.complete', { subagent_id: 'a', status: 'completed', duration_seconds: 5.5 }, 'sess-1', T0 + 9000))
    expect(detailFor(s, 'a:a', T0 + 99_000).durationS).toBe(5.5)
  })

  it('describes a profile and answers null for an unknown id', () => {
    const s = graphReduce(graphInitial(), { type: 'graph.profiles', at: T0, profiles: profiles(['default', 'writer']) })
    expect(detailFor(s, 'p:writer', T0)).toMatchObject({ kind: 'profile', title: 'writer', model: 'fake-lab-model' })
    expect(detailFor(s, 'a:ghost', T0)).toBeNull()
    expect(detailFor(s, null, T0)).toBeNull()
  })
})
