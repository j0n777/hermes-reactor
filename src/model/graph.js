// The live agent graph: a pure model. Events and snapshots in, one small state out, then a tree of nodes and a radial
// layout. No clock reads, no I/O, no DOM: time is passed in. Everything that arrives is untrusted text and loosely typed,
// so every field is cleaned, capped and type checked here.
//
// Nodes: the reactor in the middle, then profiles, then the sessions that are doing something, then subagents hanging
// from their parent (or from their session when the parent is not known). Ids are prefixed by kind: `p:`, `s:`, `a:`.
//
// Facts this model has to live with (all seen or documented in Hermes 0.23.0):
//  - events can arrive late, twice, out of order, or for an id nobody announced; a finished agent never comes back to life;
//  - a parent id can be unknown, or point back at its child;
//  - after a reconnect the event stream has a hole, so running agents become `stale` until an authoritative snapshot
//    (delegation.status lists everything that is active) says which of them still run;
//  - there can be hundreds of agents: the stored set and the drawn set are both bounded.

import { dict, dictFrom, ownGet, put } from './dict.js'
import { capLength, cleanText } from './sanitize.js'

export const subagentEventTypes = Object.freeze([
  'subagent.spawn_requested',
  'subagent.start',
  'subagent.thinking',
  'subagent.tool',
  'subagent.progress',
  'subagent.complete'
])

export const STATUSES = Object.freeze(['queued', 'running', 'completed', 'failed', 'error', 'timeout', 'interrupted', 'unknown'])
const TERMINAL = new Set(['completed', 'failed', 'error', 'timeout', 'interrupted'])

export const MAX_AGENTS = 300
export const MAX_SESSIONS = 40
export const MAX_PROFILES = 64
export const MAX_SHOWN = 60
export const MAX_PROFILES_SHOWN = 20
export const ENDED_SHOW_MS = 5 * 60_000
export const SESSION_SHOW_MS = 2 * 60_000
export const PRUNE_AFTER_MS = 30 * 60_000
export const WAKE_LIT_MS = 6_000

const PHASE_STATUS = { spawn_requested: 'queued', start: 'running', thinking: 'running', tool: 'running', progress: 'running' }

export const isTerminal = status => TERMINAL.has(status)

function rec(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function cleanId(value) {
  return typeof value === 'string' || typeof value === 'number' ? cleanText(value, 80) : ''
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

function seconds(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value * 10) / 10 : null
}

function pick(obj, ...keys) {
  for (const key of keys) if (obj[key] !== undefined && obj[key] !== null) return obj[key]
  return undefined
}

function epochMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return value < 1e11 ? Math.round(value * 1000) : Math.round(value)
}

function statusOf(value) {
  if (typeof value !== 'string') return null
  const v = value.trim().toLowerCase()
  if (!v) return null
  return STATUSES.includes(v) ? v : 'unknown'
}

function agentId(p) {
  const direct = cleanId(p.subagent_id)
  if (direct) return direct
  const delegation = cleanId(p.delegation_id)
  if (delegation) return `${delegation}:${count(p.task_index) ?? 0}`
  return cleanId(p.child_session_id) || ''
}

/** A gateway `subagent.*` event to an action, or null when it names nobody. */
export function agentFromEvent(event, now) {
  const e = rec(event)
  if (!subagentEventTypes.includes(e.type)) return null
  const p = rec(e.payload)
  const id = agentId(p)
  if (!id) return null
  const phase = e.type.slice('subagent.'.length)
  let status = null
  if (phase === 'complete') {
    const given = statusOf(p.status)
    status = given === null ? 'completed' : isTerminal(given) ? given : 'unknown'
  }
  return {
    type: 'graph.subagent',
    phase,
    id,
    parentId: cleanId(p.parent_id) || null,
    goal: capLength(cleanText(typeof p.goal === 'string' ? p.goal : '', 400), 200),
    model: typeof p.model === 'string' ? cleanText(p.model, 80) : '',
    depth: count(p.depth),
    toolCount: count(p.tool_count),
    tool: typeof p.tool_name === 'string' ? cleanText(p.tool_name, 60) : '',
    tokensIn: count(p.input_tokens),
    tokensOut: count(p.output_tokens),
    durationS: seconds(p.duration_seconds),
    status,
    sessionId: typeof e.session_id === 'string' ? cleanText(e.session_id, 120) : '',
    at: now
  }
}

/** One row from `subagent.list`, `delegation.status` or a saved spawn tree (snake case or camel case). Null without an id. */
export function normalizeSubagent(raw) {
  const r = rec(raw)
  const id = cleanId(pick(r, 'subagent_id', 'id'))
  if (!id) return null
  const text = (v, n) => (typeof v === 'string' ? cleanText(v, n) : '')
  return {
    id,
    parentId: cleanId(pick(r, 'parent_id', 'parentId')) || null,
    goal: capLength(text(r.goal, 400), 200),
    model: text(r.model, 80),
    depth: count(r.depth),
    toolCount: count(pick(r, 'tool_count', 'toolCount')),
    tool: text(pick(r, 'last_tool', 'lastTool', 'tool_name', 'tool'), 60),
    tokensIn: count(pick(r, 'input_tokens', 'inputTokens', 'tokensIn')),
    tokensOut: count(pick(r, 'output_tokens', 'outputTokens', 'tokensOut')),
    durationS: seconds(pick(r, 'duration_seconds', 'durationSeconds', 'duration_s')),
    status: statusOf(r.status),
    startedAt: epochMs(pick(r, 'started_at', 'startedAt')),
    sessionId: cleanId(pick(r, 'owner_agent_session_id', 'session_id', 'sessionId'))
  }
}

/** `profiles.list` / `host.profiles.list()` reply to a short list. */
export function normalizeProfiles(result) {
  const list = Array.isArray(rec(result).profiles) ? result.profiles : []
  const out = []
  const seen = new Set()
  for (const raw of list) {
    const r = rec(raw)
    const name = typeof r.name === 'string' ? cleanText(r.name, 64) : ''
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push({
      name,
      display: typeof r.display_name === 'string' ? cleanText(r.display_name, 48) : '',
      isDefault: r.is_default === true,
      model: typeof r.model === 'string' ? cleanText(r.model, 80) : '',
      provider: typeof r.provider === 'string' ? cleanText(r.provider, 48) : ''
    })
    if (out.length >= MAX_PROFILES) break
  }
  return out
}

export function graphInitial() {
  return { profiles: [], agents: dict(), sessions: dict(), wake: { profile: '', at: 0 }, selected: null, stale: false, updatedAt: 0 }
}

// ---- reducer ---------------------------------------------------------------------------------------------------------

function rank(status) {
  if (isTerminal(status)) return 3
  if (status === 'running') return 2
  if (status === 'queued') return 1
  return 0.5 // unknown: anything real may replace it
}

/** Merge one observation into an agent. `phase` is only used for the wording of the first sight. */
function mergeAgent(cur, patch, at, incoming) {
  const hadStatus = cur ? cur.status : null
  const next = incoming && (!cur || rank(incoming) >= rank(hadStatus)) ? incoming : hadStatus || 'unknown'
  const startedAt = cur?.startedAt ?? patch.startedAt ?? (next === 'running' || isTerminal(next) ? at : null)
  const parent = patch.parentId && patch.parentId !== patch.id ? patch.parentId : null
  return {
    id: patch.id,
    parentId: parent ?? cur?.parentId ?? null,
    goal: patch.goal || cur?.goal || '',
    model: patch.model || cur?.model || '',
    depth: patch.depth ?? cur?.depth ?? null,
    toolCount: patch.toolCount === null || patch.toolCount === undefined ? (cur?.toolCount ?? null) : Math.max(patch.toolCount, cur?.toolCount ?? 0),
    tool: patch.tool || cur?.tool || '',
    tokensIn: patch.tokensIn ?? cur?.tokensIn ?? null,
    tokensOut: patch.tokensOut ?? cur?.tokensOut ?? null,
    durationS: patch.durationS ?? cur?.durationS ?? null,
    status: next,
    startedAt,
    endedAt: isTerminal(next) || next === 'unknown' ? (cur?.endedAt ?? at) : null,
    sessionId: cur?.sessionId || patch.sessionId || '',
    lastAt: at,
    stale: false
  }
}

function enforceCap(agents) {
  const ids = Object.keys(agents)
  if (ids.length <= MAX_AGENTS) return agents
  const out = dict(agents)
  const byAge = list => list.sort((a, b) => out[a].lastAt - out[b].lastAt)
  let extra = ids.length - MAX_AGENTS
  for (const id of byAge(ids.filter(i => isTerminal(out[i].status) || out[i].status === 'unknown'))) {
    if (extra <= 0) break
    delete out[id]
    extra -= 1
  }
  for (const id of byAge(Object.keys(out))) {
    if (extra <= 0) break
    delete out[id]
    extra -= 1
  }
  return out
}

function capSessions(sessions) {
  const ids = Object.keys(sessions)
  if (ids.length <= MAX_SESSIONS) return sessions
  const keep = ids.sort((a, b) => sessions[b].lastAt - sessions[a].lastAt).slice(0, MAX_SESSIONS)
  return dictFrom(keep.map(id => [id, sessions[id]]))
}

function nodeExists(state, id) {
  if (id === 'reactor') return true
  if (typeof id !== 'string') return false
  if (id.startsWith('a:')) return Boolean(state.agents[id.slice(2)])
  if (id.startsWith('s:')) return Boolean(state.sessions[id.slice(2)]) || Object.values(state.agents).some(a => a.sessionId === id.slice(2))
  if (id.startsWith('p:')) return state.profiles.some(p => p.name === id.slice(2))
  return false
}

export function graphReduce(state, action) {
  switch (action.type) {
    case 'graph.subagent': {
      const cur = state.agents[action.id]
      if (cur && isTerminal(cur.status)) {
        // A finished agent stays finished. A second `complete` may only fill what the first one left empty.
        if (action.phase !== 'complete') return state
        const filled = { ...cur, tokensIn: cur.tokensIn ?? action.tokensIn, tokensOut: cur.tokensOut ?? action.tokensOut, durationS: cur.durationS ?? action.durationS }
        return filled.tokensIn === cur.tokensIn && filled.tokensOut === cur.tokensOut && filled.durationS === cur.durationS ? state : { ...state, agents: put(state.agents, action.id, filled) }
      }
      const incoming = action.status ?? ownGet(PHASE_STATUS, action.phase) ?? null
      const merged = mergeAgent(cur, action, action.at, incoming)
      return { ...state, agents: enforceCap(put(state.agents, action.id, merged)), updatedAt: action.at }
    }

    case 'graph.snapshot': {
      const agents = dict(state.agents)
      const seen = new Set()
      for (const row of action.agents) {
        if (!row) continue
        seen.add(row.id)
        const cur = agents[row.id]
        if (cur && isTerminal(cur.status)) continue
        const incoming = row.status && row.status !== 'unknown' ? row.status : cur ? null : 'running'
        agents[row.id] = mergeAgent(cur, row, action.at, incoming)
      }
      if (action.authoritative) {
        for (const [id, a] of Object.entries(agents)) {
          if (!seen.has(id) && (a.status === 'running' || a.status === 'queued')) {
            agents[id] = { ...a, status: 'unknown', endedAt: action.at, stale: false, lastAt: action.at }
          }
        }
      }
      for (const [id, a] of Object.entries(agents)) if (a.stale) agents[id] = { ...a, stale: false }
      return { ...state, agents: enforceCap(agents), stale: false, updatedAt: action.at }
    }

    case 'graph.history': {
      const agents = dict(state.agents)
      for (const row of action.agents) {
        if (!row) continue
        const cur = agents[row.id]
        if (cur && cur.status !== 'unknown') continue
        const status = row.status && isTerminal(row.status) ? row.status : 'unknown'
        agents[row.id] = mergeAgent(cur, row, action.at, status)
      }
      return { ...state, agents: enforceCap(agents), updatedAt: action.at }
    }

    case 'graph.disconnect': {
      const agents = dict()
      for (const [id, a] of Object.entries(state.agents)) agents[id] = a.status === 'running' || a.status === 'queued' ? { ...a, stale: true } : a
      return { ...state, agents, stale: true }
    }

    case 'graph.profiles':
      return { ...state, profiles: action.profiles.slice(0, MAX_PROFILES), updatedAt: action.at }

    case 'graph.session': {
      const id = cleanId(action.id)
      if (!id) return state
      const prev = state.sessions[id]
      const profile = typeof action.profile === 'string' && action.profile ? cleanText(action.profile, 64) : prev?.profile || ''
      if (prev && prev.phase === action.phase && prev.profile === profile && action.at - prev.lastAt < 1000) return state
      return { ...state, sessions: capSessions(put(state.sessions, id, { id, profile, phase: action.phase || 'idle', lastAt: action.at })) }
    }

    case 'graph.wake':
      return { ...state, wake: { profile: typeof action.profile === 'string' ? cleanText(action.profile, 64) : '', at: action.at } }

    case 'graph.select': {
      const id = action.id ?? null
      if (id === state.selected) return state
      if (id !== null && !nodeExists(state, id)) return state.selected === null ? state : { ...state, selected: null }
      return { ...state, selected: id }
    }

    case 'graph.prune': {
      const agents = dict()
      let changed = false
      for (const [id, a] of Object.entries(state.agents)) {
        if ((isTerminal(a.status) || a.status === 'unknown') && action.now - a.lastAt > PRUNE_AFTER_MS) changed = true
        else agents[id] = a
      }
      const sessions = dict()
      for (const [id, s] of Object.entries(state.sessions)) {
        if (s.phase === 'idle' && action.now - s.lastAt > PRUNE_AFTER_MS) changed = true
        else sessions[id] = s
      }
      if (!changed) return state
      const next = { ...state, agents, sessions }
      return state.selected && !nodeExists(next, state.selected) ? { ...next, selected: null } : next
    }

    default:
      return state
  }
}

// ---- the tree to draw --------------------------------------------------------------------------------------------------

function shortLabel(id) {
  return capLength(id, 14)
}

/**
 * @param {ReturnType<typeof graphInitial>} state
 * @param {{ now: number, reactorState?: string, activeProfile?: string }} opts
 * @returns {{ nodes: object[], edges: object[], hidden: number }}
 */
export function buildGraph(state, { now, reactorState = 'idle', activeProfile = '' }) {
  const nodes = [{ id: 'reactor', kind: 'reactor', label: '', status: reactorState, lit: false, stale: false, tier: 0 }]
  const edges = []
  const byId = new Map([['reactor', nodes[0]]])
  let hidden = 0

  const add = (node, parent) => {
    if (byId.has(node.id)) return
    byId.set(node.id, node)
    nodes.push(node)
    edges.push({ from: parent, to: node.id, status: node.status })
  }

  // Profiles. When none is known yet the wake and the sessions name the ones we can draw.
  let names = state.profiles.map(p => p.name)
  const known = new Map(state.profiles.map(p => [p.name, p]))
  if (names.length === 0) {
    const implied = []
    if (state.wake.profile) implied.push(state.wake.profile)
    for (const s of Object.values(state.sessions)) if (s.profile && !implied.includes(s.profile)) implied.push(s.profile)
    names = implied
  }
  const defaultName = state.profiles.find(p => p.isDefault)?.name ?? names[0] ?? ''
  hidden += Math.max(0, names.length - MAX_PROFILES_SHOWN)
  const woken = state.wake.at && now - state.wake.at <= WAKE_LIT_MS
  const wakeTarget = woken ? (names.includes(state.wake.profile) ? state.wake.profile : defaultName) : ''
  for (const name of names.slice(0, MAX_PROFILES_SHOWN)) {
    const p = known.get(name)
    add({ id: `p:${name}`, kind: 'profile', label: shortLabel(name), status: 'idle', lit: name === wakeTarget, stale: false, tier: 1, isDefault: p?.isDefault === true }, 'reactor')
  }
  const profileNode = name => (byId.has(`p:${name}`) ? `p:${name}` : defaultName && byId.has(`p:${defaultName}`) ? `p:${defaultName}` : 'reactor')
  const base = activeProfile && byId.has(`p:${activeProfile}`) ? `p:${activeProfile}` : profileNode(defaultName)

  // Which agents are worth drawing, and under whom.
  const agents = state.agents
  const cycle = id => {
    const seen = new Set([id])
    let at = agents[id]?.parentId
    for (let hop = 0; at && hop < 32; hop += 1) {
      if (seen.has(at)) return at === id
      seen.add(at)
      at = agents[at]?.parentId
    }
    return false
  }
  const parentAgent = id => {
    const pid = agents[id].parentId
    return pid && agents[pid] && !cycle(id) ? pid : null
  }
  const sessionOf = id => agents[id].sessionId || ''
  const sessionParent = sid => {
    const s = state.sessions[sid]
    return s?.profile ? profileNode(s.profile) : base
  }
  const endedTime = a => a.endedAt ?? a.lastAt
  const wanted = Object.values(agents).filter(a => !(isTerminal(a.status) || a.status === 'unknown') || now - endedTime(a) <= ENDED_SHOW_MS)
  const score = a => (a.status === 'running' ? 3e15 : a.status === 'queued' ? 2e15 : 1e15) + a.lastAt

  const chosen = new Set()
  const sessionsChosen = new Set()
  const sessionCap = Object.values(state.sessions).filter(s => s.phase !== 'idle' || now - s.lastAt <= SESSION_SHOW_MS)
  for (const s of sessionCap) sessionsChosen.add(s.id)
  const budget = () => MAX_SHOWN - (nodes.length - 1) - sessionsChosen.size - chosen.size
  for (const a of [...wanted].sort((x, y) => score(y) - score(x))) {
    const chain = []
    let at = a.id
    for (let hop = 0; at && hop < 32; hop += 1) {
      if (!chosen.has(at)) chain.push(at)
      at = parentAgent(at)
    }
    const extraSessions = new Set(chain.map(sessionOf).filter(s => s && !sessionsChosen.has(s)))
    if (chain.length + extraSessions.size > budget()) continue
    for (const id of chain) chosen.add(id)
    for (const s of extraSessions) sessionsChosen.add(s)
  }
  hidden += wanted.filter(a => !chosen.has(a.id)).length

  // Sessions (those doing something, plus those a drawn agent hangs from), then agents parents first.
  for (const sid of [...sessionsChosen].sort()) {
    const s = state.sessions[sid]
    add({ id: `s:${sid}`, kind: 'session', label: shortLabel(sid), status: s?.phase && s.phase !== 'idle' ? s.phase : 'idle', lit: false, stale: false, tier: 2 }, sessionParent(sid))
  }
  const depthOf = id => {
    let d = 0
    for (let at = parentAgent(id); at && d < 32; at = parentAgent(at)) d += 1
    return d
  }
  for (const id of [...chosen].sort((a, b) => depthOf(a) - depthOf(b) || agents[a].lastAt - agents[b].lastAt)) {
    const a = agents[id]
    const parent = parentAgent(id)
    const under = parent && chosen.has(parent) ? `a:${parent}` : sessionOf(id) && byId.has(`s:${sessionOf(id)}`) ? `s:${sessionOf(id)}` : base
    add({ id: `a:${id}`, kind: 'agent', label: a.goal ? capLength(a.goal, 18) : shortLabel(id), status: a.status, lit: false, stale: a.stale === true, tier: 3 }, under)
  }
  return { nodes, edges, hidden }
}

/** What the side panel shows for a selected node. Null for an id that is not there. */
export function detailFor(state, id, now) {
  if (typeof id !== 'string') return null
  if (id.startsWith('a:')) {
    const a = state.agents[id.slice(2)]
    if (!a) return null
    const live = !isTerminal(a.status) && a.status !== 'unknown'
    let durationS = null
    if (live) durationS = a.startedAt ? Math.max(0, Math.round((now - a.startedAt) / 100) / 10) : null
    else durationS = a.durationS ?? (a.startedAt && a.endedAt ? Math.max(0, Math.round((a.endedAt - a.startedAt) / 100) / 10) : null)
    return { kind: 'agent', id, title: a.id, goal: a.goal, model: a.model, tool: a.tool, toolCount: a.toolCount, tokensIn: a.tokensIn, tokensOut: a.tokensOut, status: a.status, durationS, depth: a.depth, parentId: a.parentId, stale: a.stale === true }
  }
  if (id.startsWith('p:')) {
    const p = state.profiles.find(x => x.name === id.slice(2))
    return p ? { kind: 'profile', id, title: p.name, display: p.display, model: p.model, provider: p.provider, isDefault: p.isDefault } : null
  }
  if (id.startsWith('s:')) {
    const s = state.sessions[id.slice(2)]
    return s ? { kind: 'session', id, title: s.id, profile: s.profile, phase: s.phase } : null
  }
  if (id === 'reactor') return { kind: 'reactor', id, title: 'reactor' }
  return null
}

// ---- layout ------------------------------------------------------------------------------------------------------------

const NODE_R = { reactor: 38, profile: 18, session: 14, agent: 13 }

/** The reactor node grows with the box (it carries the reactor artwork), within bounds that leave room for the rings. */
export function reactorRadius(width, height) {
  const small = Math.max(1, Math.min(width, height))
  return Math.round(Math.min(Math.max(NODE_R.reactor, small * 0.17), small / 4))
}

/**
 * A radial tree: the reactor at the center, one ring per depth, each node's angular share proportional to how many leaves
 * hang below it. Deterministic, and every node stays inside the box.
 */
export function layoutGraph(graph, { width, height }) {
  const w = Math.max(1, width)
  const h = Math.max(1, height)
  const cx = w / 2
  const cy = h / 2
  const kids = new Map()
  for (const e of graph.edges) {
    if (!kids.has(e.from)) kids.set(e.from, [])
    kids.get(e.from).push(e.to)
  }
  const weight = new Map()
  const weigh = id => {
    if (weight.has(id)) return weight.get(id)
    const c = kids.get(id) ?? []
    const total = c.length === 0 ? 1 : c.reduce((sum, k) => sum + weigh(k), 0)
    weight.set(id, total)
    return total
  }
  weigh('reactor')

  const level = new Map([['reactor', 0]])
  const order = ['reactor']
  for (let i = 0; i < order.length; i += 1) {
    for (const k of kids.get(order[i]) ?? []) {
      if (level.has(k)) continue
      level.set(k, level.get(order[i]) + 1)
      order.push(k)
    }
  }
  const maxLevel = Math.max(1, ...level.values())
  const margin = 34
  // Rings are ellipses, so a wide box uses its width instead of leaving it empty.
  const radiusX = Math.max(0, w / 2 - margin)
  const radiusY = Math.max(0, h / 2 - margin)
  const reactorR = reactorRadius(w, h)
  // The first ring starts just outside the (large) reactor; the last one reaches the edge of the box.
  const innerFrac = Math.min(0.55, (reactorR + 52) / Math.max(1, radiusY))
  const ring = depth => (maxLevel === 1 ? 1 : innerFrac + (1 - innerFrac) * ((depth - 1) / (maxLevel - 1)))

  const angle = new Map([['reactor', { from: -Math.PI / 2, to: (3 * Math.PI) / 2 }]])
  const placed = new Map()
  const byId = new Map(graph.nodes.map(n => [n.id, n]))
  const radiusOf = n => (n.kind === 'reactor' ? reactorR : Math.min(NODE_R[n.kind] ?? 10, Math.max(1, Math.min(w, h) / 6)))
  const clamp = (v, r, size) => Math.min(Math.max(v, r), Math.max(r, size - r))

  for (const id of order) {
    const node = byId.get(id)
    if (!node) continue
    const span = angle.get(id)
    const mid = (span.from + span.to) / 2
    const r = radiusOf(node)
    const dist = ring(level.get(id))
    placed.set(id, { ...node, x: id === 'reactor' ? clamp(cx, r, w) : clamp(cx + dist * radiusX * Math.cos(mid), r, w), y: id === 'reactor' ? clamp(cy, r, h) : clamp(cy + dist * radiusY * Math.sin(mid), r, h), r })
    let cursor = span.from
    const total = weight.get(id)
    for (const k of kids.get(id) ?? []) {
      const share = ((span.to - span.from) * weight.get(k)) / total
      angle.set(k, { from: cursor, to: cursor + share })
      cursor += share
    }
  }
  const outNodes = graph.nodes.map(n => placed.get(n.id)).filter(Boolean)
  const outEdges = graph.edges
    .filter(e => placed.has(e.from) && placed.has(e.to))
    .map(e => ({ ...e, x1: placed.get(e.from).x, y1: placed.get(e.from).y, x2: placed.get(e.to).x, y2: placed.get(e.to).y }))
  return { nodes: outNodes, edges: outEdges, hidden: graph.hidden, width: w, height: h }
}

/**
 * Add what `host.profileRoutes()` knows: profiles served by other connections (remote ones) that `host.profiles.list()`
 * of the active connection does not return, and the connection of each local one. Bad rows are ignored.
 */
export function mergeRoutes(profiles, routes) {
  const out = profiles.map(p => ({ ...p, remote: p.remote === true, connection: p.connection ?? '' }))
  if (!Array.isArray(routes)) return out
  for (const raw of routes) {
    const r = rec(raw)
    const name = typeof r.targetProfile === 'string' ? cleanText(r.targetProfile, 64) : ''
    if (!name) continue
    const connection = typeof r.connectionId === 'string' ? cleanText(r.connectionId, 48) : ''
    const remote = r.mode === 'remote'
    const at = out.findIndex(p => p.name === name)
    if (at >= 0) {
      if (!out[at].connection) out[at] = { ...out[at], connection }
      continue
    }
    if (out.length >= MAX_PROFILES) break
    out.push({ name, display: '', isDefault: false, model: '', provider: '', remote, connection })
  }
  return out
}
