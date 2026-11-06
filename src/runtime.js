// The runtime: stores, controller, pollers and the wiring between Hermes and the pure
// models. Every outside dependency is injected, so the Desktop entry (index.js) passes the
// real SDK and the dev harness passes fakes. Nothing here touches the DOM or the network.

import { PAGE_LIMIT, agentsInitial, agentsReduce, briefPrompt, normalizeList } from './model/agents.js'
import { createApprovalController } from './model/approval-controller.js'
import { asksInitial, asksReduce, createAskController, waitingCount as asksWaiting } from './model/asks.js'
import { assistantInitial, assistantReduce, createAssistantController } from './model/assistant.js'
import { WATCHED_EVENT_TYPES, toAction } from './model/events.js'
import { graphInitial, graphReduce } from './model/graph.js'
import { createGraphController, graphEventTypes, toGraphActions } from './model/graph-controller.js'
import { makeT, resolveLocale } from './model/i18n.js'
import { KANBAN_EVENTS, kanbanInitial, kanbanReduce, toKanbanAction } from './model/kanban.js'
import { cleanText } from './model/sanitize.js'
import { SHOW_EVENT, createShowController } from './model/screens.js'
import { createPoller } from './model/poller.js'
import { createProposalController, proposalsInitial, proposalsReduce, waitingCount as proposalsWaiting } from './model/proposals.js'
import { initialState, reduce } from './model/state.js'
import { createStore } from './model/store.js'

export const AGENTS_POLL_MS = 30_000
export const APPROVAL_POLL_MS = 5_000
export const PROPOSALS_POLL_MS = 4_000
export const ASKS_POLL_MS = 4_000
export const GRAPH_POLL_MS = 6_000

function clock({ setInterval, now }) {
  const listeners = new Set()
  let current = now()
  let stop = null
  return {
    getNow: () => {
      // Without a ticking subscriber the cached time would be stale: refresh it, at most once a second.
      if (!stop) {
        const t = now()
        if (t - current >= 1000) current = t
      }
      return current
    },
    subscribe(listener) {
      listeners.add(listener)
      if (!stop) {
        current = now()
        stop = setInterval(() => {
          current = now()
          for (const l of [...listeners]) l()
        }, 1000)
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && stop) {
          stop()
          stop = null
        }
      }
    }
  }
}

function prefStore({ storage }) {
  const listeners = new Set()
  let value = 'auto'
  try {
    const saved = storage.get('locale', 'auto')
    if (saved === 'en' || saved === 'pt-BR') value = saved
  } catch {
    // Storage can be unavailable; the default is fine.
  }
  return {
    get: () => value,
    set(next) {
      value = next === 'en' || next === 'pt-BR' ? next : 'auto'
      try {
        storage.set('locale', value)
      } catch {
        // Not persisted; still applied for this session.
      }
      for (const l of [...listeners]) l()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

/**
 * @param {{
 *   request: (method: string, params?: object, timeoutMs?: number) => Promise<any>,
 *   rest?: (path: string, opts?: object) => Promise<any>,
 *   onEvent: (type: string, fn: (event: any) => void) => (() => void),
 *   setTimeout: (fn: () => void, ms: number) => (() => void),
 *   setInterval: (fn: () => void, ms: number) => (() => void),
 *   storage: { get: (k: string, d: any) => any, set: (k: string, v: any) => void },
 *   hostState: Record<string, { get: () => any, subscribe: (fn: (v: any) => void) => (() => void) }>,
 *   notify: (n: { kind: string, message: string }) => void,
 *   composer: { insertText: (sid: any, text: string, opts?: object) => Promise<boolean>, focus: (sid: any) => void },
 *   navigate: (path: string) => void,
 *   approvalTimeoutMs?: number,
 *   isVisible?: () => boolean,
 *   now?: () => number
 * }} deps
 */
export function createRuntime(deps) {
  const now = deps.now ?? Date.now
  const isVisible = deps.isVisible ?? (() => true)

  const store = createStore(reduce, initialState())
  const agents = createStore(agentsReduce, agentsInitial())
  const controller = createApprovalController({
    getState: store.getState,
    dispatch: store.dispatch,
    request: deps.request,
    timeoutMs: deps.approvalTimeoutMs,
    now
  })

  const gatewayOpen = () => store.getState().host.gateway === 'open'

  // ---- continue-session proposals (Python backend, via ctx.rest) --------------
  const proposals = createStore(proposalsReduce, proposalsInitial())
  const proposalController = createProposalController({
    getState: proposals.getState,
    dispatch: proposals.dispatch,
    rest: deps.rest ?? (async () => { throw new Error('The Reactor backend is not reachable from here') }),
    now
  })
  const proposalsPoller = createPoller({
    run: async () => (await proposalController.refresh()).ok,
    intervalMs: PROPOSALS_POLL_MS,
    canRun: () => Boolean(deps.rest) && gatewayOpen(),
    setTimer: deps.setTimeout
  })

  // ---- language (for the few texts made outside React: notices) -----------------
  const localePref = prefStore({ storage: deps.storage })
  let appLocale = null
  const currentLocale = () =>
    resolveLocale({
      preference: localePref.get(),
      appLocale,
      navigatorLanguages: typeof navigator !== 'undefined' && navigator.languages ? Array.from(navigator.languages) : []
    })
  const tNow = key => makeT(currentLocale())(key)

  // ---- assistant name ------------------------------------------------------
  const noRest = async () => {
    throw new Error('The Reactor backend is not reachable from here')
  }
  const assistant = createStore(assistantReduce, assistantInitial())
  const assistantController = createAssistantController({
    getState: assistant.getState,
    dispatch: assistant.dispatch,
    rest: deps.rest ?? noRest,
    storage: deps.storage
  })

  // ---- live agent graph --------------------------------------------------------
  const graph = createStore(graphReduce, graphInitial())
  const profileHint = () => {
    try {
      const v = deps.hostState.focusedSessionProfile?.get?.()
      return typeof v === 'string' ? v : ''
    } catch {
      return ''
    }
  }
  const graphController = createGraphController({
    getState: graph.getState,
    dispatch: graph.dispatch,
    request: deps.request,
    listProfiles: deps.listProfiles ?? (async () => null),
    profileRoutes: deps.profileRoutes ?? (async () => []),
    focusedSession: () => store.getState().host.focusedSessionId,
    now
  })
  const graphPoller = createPoller({
    run: async () => (await graphController.refresh()).ok,
    intervalMs: GRAPH_POLL_MS,
    canRun: () => gatewayOpen() && isVisible(),
    setTimer: deps.setTimeout
  })
  let graphViewers = 0

  // ---- ask another profile (Python backend, via ctx.rest) -------------------------
  const asks = createStore(asksReduce, asksInitial())
  const askController = createAskController({
    getState: asks.getState,
    dispatch: asks.dispatch,
    rest: deps.rest ?? noRest,
    routes: async () => (deps.profileRoutes ? deps.profileRoutes() : []),
    requestProfile: deps.requestProfile ?? noRest,
    retainProfile: deps.retainProfile,
    now
  })
  const asksPoller = createPoller({
    run: async () => (await askController.refresh()).ok,
    intervalMs: ASKS_POLL_MS,
    canRun: () => Boolean(deps.rest) && gatewayOpen(),
    setTimer: deps.setTimeout
  })

  // ---- kanban (read only) and the screens the model can ask for ------------------------
  const kanban = createStore(kanbanReduce, kanbanInitial())
  const ui = createStore((state, action) => (action.type === 'ui.focus' ? { focus: action.focus, at: action.at } : state), { focus: '', at: 0 })
  /** True while any approval, continue or ask card is waiting for a click (or being answered). The model may not move the screen then. */
  function hasPendingCard() {
    const at = now()
    return store.getState().approvals.length > 0 || proposalsWaiting(proposals.getState(), at) > 0 || asksWaiting(asks.getState(), at) > 0
  }
  /** Ask the stage to show the graph. Refused (false) while a card is pending: nothing scrolls or switches under it. */
  function focusGraphView() {
    if (hasPendingCard()) return false
    ui.dispatch({ type: 'ui.focus', focus: 'graph', at: now() })
    return true
  }
  const show = createShowController({
    navigate: deps.navigate,
    runAction: deps.runAction,
    pluginEnabled: deps.pluginEnabled ?? (() => false),
    focusGraph: focusGraphView,
    notify: n => deps.notify(n),
    t: tNow,
    cardsPending: hasPendingCard,
    now
  })

  // ---- agents list -------------------------------------------------------
  async function loadAgents() {
    agents.dispatch({ type: 'agents.start' })
    try {
      const list = normalizeList(await deps.request('session.foreign.list', { offset: 0, limit: PAGE_LIMIT }))
      if (!list) throw new Error('Unexpected reply from Hermes')
      agents.dispatch({ type: 'agents.ok', list, at: now() })
      return true
    } catch (error) {
      agents.dispatch({ type: 'agents.fail', message: cleanText(error && error.message ? error.message : '', 160) })
      return false
    }
  }

  const agentsPoller = createPoller({
    run: loadAgents,
    intervalMs: AGENTS_POLL_MS,
    canRun: () => gatewayOpen() && isVisible(),
    setTimer: deps.setTimeout
  })
  let viewers = 0

  // ---- approvals (the legacy request path is invisible to events, so ask) --
  async function syncApprovals() {
    const ids = controller.sessionsToSync()
    if (ids.length === 0) return true
    const results = await Promise.all(ids.map(id => controller.syncSession(id)))
    return results.every(r => r.ok || r.reason === 'superseded' || r.reason === 'offline')
  }

  const approvalPoller = createPoller({
    run: syncApprovals,
    intervalMs: APPROVAL_POLL_MS,
    canRun: () => {
      const s = store.getState()
      return s.host.gateway === 'open' && (s.host.busy || s.host.awaiting || s.approvals.length > 0)
    },
    setTimer: deps.setTimeout
  })

  // ---- wiring ------------------------------------------------------------
  const disposers = []
  let started = false

  function start() {
    if (started) return () => {}
    started = true

    // One listener per event type: the reactor state and the graph both read the same frame.
    for (const type of new Set([...WATCHED_EVENT_TYPES, ...graphEventTypes])) {
      disposers.push(
        deps.onEvent(type, event => {
          if (WATCHED_EVENT_TYPES.includes(type)) {
            const action = toAction(event, now())
            if (action) store.dispatch(action)
          }
          if (graphEventTypes.includes(type)) {
            for (const action of toGraphActions(event, now(), { profile: profileHint() })) graph.dispatch(action)
          }
        })
      )
    }
    // Events from the Python half of this plugin.
    disposers.push(deps.onEvent(SHOW_EVENT, event => void show.showFromEvent(event)))
    for (const type of KANBAN_EVENTS) {
      disposers.push(
        deps.onEvent(type, event => {
          const action = toKanbanAction(event, now())
          if (!action) return
          kanban.dispatch(action)
          try {
            if (deps.onKanbanChange) deps.onKanbanChange()
          } catch {
            // The badge repaint is a courtesy.
          }
        })
      )
    }
    assistantController.load()
    if (deps.rest) void assistantController.push()

    const hostKeys = {
      gateway: 'gateway',
      busy: 'busy',
      awaiting: 'awaitingResponse',
      focusedSessionId: 'focusedSessionId',
      activeSessionId: 'activeSessionId'
    }
    for (const [field, atomName] of Object.entries(hostKeys)) {
      const atom = deps.hostState[atomName]
      if (!atom) continue
      disposers.push(atom.subscribe(value => store.dispatch({ type: 'host', patch: { [field]: value } })))
    }

    // A reconnect, or a change of focused chat, is the moment to ask what is pending.
    let lastGateway = store.getState().host.gateway
    let lastFocus = store.getState().host.focusedSessionId
    disposers.push(
      store.subscribe(() => {
        const { gateway, focusedSessionId } = store.getState().host
        const reopened = gateway === 'open' && lastGateway !== 'open'
        const refocused = gateway === 'open' && focusedSessionId !== lastFocus
        const dropped = gateway !== 'open' && lastGateway === 'open'
        lastGateway = gateway
        lastFocus = focusedSessionId
        if (reopened || refocused) void syncApprovals()
        if (reopened && viewers > 0) void agentsPoller.refresh()
        // A hole in the event stream: what was running is unconfirmed until Hermes says otherwise.
        if (dropped) void graphController.connection('closed')
        if (reopened) {
          void graphController.connection('open')
          if (deps.rest) void assistantController.push()
        }
      })
    )
    if (gatewayOpen()) void syncApprovals()

    approvalPoller.start()
    disposers.push(() => approvalPoller.stop())
    if (deps.rest) {
      proposalsPoller.start()
      disposers.push(() => proposalsPoller.stop())
      asksPoller.start()
      disposers.push(() => asksPoller.stop())
    }
    disposers.push(() => agentsPoller.stop())
    disposers.push(() => graphPoller.stop())

    return stop
  }

  function stop() {
    started = false
    while (disposers.length) {
      try {
        disposers.pop()()
      } catch {
        // Keep disposing the rest.
      }
    }
  }

  // ---- ui helpers ----------------------------------------------------------
  function retainAgents() {
    viewers += 1
    if (viewers === 1) agentsPoller.start()
    return () => {
      viewers = Math.max(0, viewers - 1)
      if (viewers === 0) agentsPoller.stop()
    }
  }

  function retainGraph() {
    graphViewers += 1
    if (graphViewers === 1) graphPoller.start()
    let released = false
    return () => {
      if (released) return
      released = true
      graphViewers = Math.max(0, graphViewers - 1)
      if (graphViewers === 0) graphPoller.stop()
    }
  }

  async function briefSession(row, t, sessionId = null) {
    const text = briefPrompt(row, t)
    let inserted = false
    try {
      inserted = await deps.composer.insertText(sessionId, text, { mode: 'block' })
    } catch {
      inserted = false
    }
    if (inserted) {
      try {
        deps.composer.focus(sessionId)
      } catch {
        // Focus is a courtesy.
      }
      deps.notify({ kind: 'info', message: t('agents.briefDone') })
    } else {
      deps.notify({ kind: 'warning', message: t('agents.briefNoChat') })
    }
    return inserted
  }

  return {
    store,
    agents,
    controller,
    proposals,
    proposalController,
    refreshProposals: () => proposalsPoller.refresh(),
    clock: clock({ setInterval: deps.setInterval, now }),
    localePref,
    noteAppLocale: value => {
      appLocale = typeof value === 'string' ? value : null
    },
    getLocale: currentLocale,
    assistant,
    assistantController,
    setAssistantName: value => assistantController.set(value),
    graph,
    graphController,
    retainGraph,
    refreshGraph: () => graphPoller.refresh(),
    selectNode: id => graph.dispatch({ type: 'graph.select', id }),
    asks,
    askController,
    refreshAsks: () => asksPoller.refresh(),
    kanban,
    ui,
    show,
    hasPendingCard,
    focusGraphView,
    clearFocus: () => ui.dispatch({ type: 'ui.focus', focus: '', at: now() }),
    start,
    stop,
    retainAgents,
    refreshAgents: () => agentsPoller.refresh(),
    briefSession,
    openStage: () => deps.navigate('/reactor'),
    notify: deps.notify,
    now
  }
}
