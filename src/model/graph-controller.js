// Feeding the graph: gateway events become actions, and a refresh asks Hermes what is really there (profiles, the active
// delegation tree, the focused session's children, one saved spawn tree). All I/O is injected, nothing here touches the DOM.
//
// What each source is good for:
//  - `subagent.*` events are live but have holes (a window opened late, a dropped socket);
//  - `delegation.status` lists every ACTIVE child of the launch profile, so it is authoritative for "what is running":
//    a child missing from it is not running any more;
//  - `subagent.list` shows the children owned by one session (not authoritative for the others);
//  - `spawn_tree.list` / `spawn_tree.load` are saved snapshots of finished trees: history only, loaded once per connection.
// A failed call proves nothing and changes nothing.

import { agentFromEvent, mergeRoutes, normalizeProfiles, normalizeSubagent, subagentEventTypes } from './graph.js'

export const graphEventTypes = Object.freeze([...subagentEventTypes, 'wake.detected', 'message.start', 'message.delta', 'message.complete'])

/** One gateway event to graph actions (usually zero or one). `hint.profile` names the profile the focused chat belongs to. */
export function toGraphActions(event, now, hint = {}) {
  if (!event || typeof event !== 'object' || event.replayed === true) return []
  const type = typeof event.type === 'string' ? event.type : ''
  if (subagentEventTypes.includes(type)) {
    const action = agentFromEvent(event, now)
    return action ? [action] : []
  }
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {}
  if (type === 'wake.detected') return [{ type: 'graph.wake', profile: typeof payload.profile === 'string' ? payload.profile : '', at: now }]
  const sessionId = typeof event.session_id === 'string' ? event.session_id : ''
  if (!sessionId) return []
  const profile = typeof hint.profile === 'string' ? hint.profile : ''
  if (type === 'message.start') return [{ type: 'graph.session', id: sessionId, profile, phase: 'thinking', at: now }]
  if (type === 'message.delta') return typeof payload.text === 'string' && payload.text ? [{ type: 'graph.session', id: sessionId, profile, phase: 'responding', at: now }] : []
  if (type === 'message.complete') return [{ type: 'graph.session', id: sessionId, profile, phase: 'idle', at: now }]
  return []
}

/**
 * @param {{
 *   getState: Function, dispatch: (a: object) => void,
 *   request: (method: string, params?: object) => Promise<any>,
 *   listProfiles: () => Promise<any>, profileRoutes: () => Promise<any>,
 *   focusedSession: () => (string | null),
 *   now?: () => number
 * }} deps
 */
export function createGraphController({ getState, dispatch, request, listProfiles, profileRoutes, focusedSession, now = Date.now }) {
  let online = true
  let busy = false
  let historyLoaded = false

  const list = value => (Array.isArray(value) ? value : [])

  async function loadProfiles() {
    let result
    try {
      result = await listProfiles()
    } catch {
      result = null
    }
    let routes = []
    try {
      routes = list(await profileRoutes())
    } catch {
      routes = []
    }
    const profiles = normalizeProfiles(result)
    if (profiles.length === 0 && routes.length === 0) return false
    dispatch({ type: 'graph.profiles', profiles: mergeRoutes(profiles, routes), at: now() })
    return true
  }

  async function loadActive() {
    let result
    try {
      result = await request('delegation.status', {})
    } catch {
      return false
    }
    if (!result || typeof result !== 'object' || !Array.isArray(result.active)) return false
    dispatch({ type: 'graph.snapshot', authoritative: true, at: now(), agents: result.active.map(normalizeSubagent).filter(Boolean) })
    return true
  }

  async function loadSession() {
    const sessionId = focusedSession()
    if (!sessionId) return false
    let result
    try {
      result = await request('subagent.list', { session_id: sessionId })
    } catch {
      return false
    }
    if (!result || typeof result !== 'object' || !Array.isArray(result.subagents)) return false
    const agents = result.subagents.map(normalizeSubagent).filter(Boolean).map(a => (a.sessionId ? a : { ...a, sessionId }))
    dispatch({ type: 'graph.snapshot', authoritative: false, at: now(), agents })
    return true
  }

  async function loadHistory() {
    if (historyLoaded) return
    historyLoaded = true
    try {
      const listed = await request('spawn_tree.list', { cross_session: true, limit: 3 })
      const entries = listed && typeof listed === 'object' ? list(listed.entries) : []
      const path = entries.find(e => e && typeof e.path === 'string' && e.path)?.path
      if (!path) return
      const tree = await request('spawn_tree.load', { path })
      const rows = tree && typeof tree === 'object' ? list(tree.subagents) : []
      dispatch({ type: 'graph.history', at: now(), agents: rows.map(normalizeSubagent).filter(Boolean) })
    } catch {
      historyLoaded = false // try again on the next refresh
    }
  }

  async function refresh() {
    if (!online) return { ok: false, reason: 'offline' }
    if (busy) return { ok: false, reason: 'busy' }
    busy = true
    try {
      const [profilesOk, activeOk] = await Promise.all([loadProfiles(), loadActive()])
      await loadSession()
      await loadHistory()
      dispatch({ type: 'graph.prune', now: now() })
      return { ok: profilesOk || activeOk }
    } finally {
      busy = false
    }
  }

  /** 'open' refreshes; anything else marks what was running as stale until the next good snapshot. */
  function connection(state) {
    if (state === 'open') {
      online = true
      historyLoaded = false
      return refresh()
    }
    online = false
    dispatch({ type: 'graph.disconnect', at: now() })
    return Promise.resolve({ ok: false, reason: 'offline' })
  }

  return { refresh, connection }
}
