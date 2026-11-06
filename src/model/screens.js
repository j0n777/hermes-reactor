// reactor_show on the Desktop side. The Python tool sends one plugin event with a view name; this file validates the name
// against the same closed list and opens the screen with `host.navigate` or `ctx.runAction`. An unknown view does nothing.
//
// Keep SHOW_VIEWS identical to VIEWS in reactor_hermes/screens.py (a test compares the two files).
//
// Only view and navigation things happen here: the app actions are the SDK's own allow-list (nav.*), nothing is
// created, deleted or changed.

export const SHOW_EVENT = 'plugin.hermes-reactor.show'
export const STAGE_PATH = '/reactor'
export const KANBAN_PATH = '/kanban'
export const SHOW_VIEWS = Object.freeze(['stage', 'graph', 'agents', 'profiles', 'kanban', 'cron', 'messaging', 'capabilities'])

export const SHOW_PLAN = Object.freeze({
  stage: { navigate: STAGE_PATH },
  graph: { navigate: STAGE_PATH, focus: 'graph' },
  agents: { action: 'nav.agents' },
  profiles: { action: 'nav.profiles' },
  // Kanban ships OFF by default in Hermes Desktop 0.23.0 (defaultEnabled: false): the route exists only once the person turned it on.
  kanban: { navigate: KANBAN_PATH, needsPlugin: 'kanban' },
  cron: { action: 'nav.cron' },
  messaging: { action: 'nav.messaging' },
  capabilities: { action: 'nav.capabilities' }
})

const REPEAT_MS = 2000
// One navigation per 3 seconds across all views, for anything the model asked for. Keep identical to MIN_GAP_SECONDS in
// reactor_hermes/screens.py. A person's own click is never throttled.
export const MIN_GAP_MS = 3000

/** The view named by a payload, or null. Exact match only: no trimming, no case folding (Python already did that). */
export function validateShow(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const view = payload.view
  return typeof view === 'string' && SHOW_VIEWS.includes(view) ? view : null
}

/**
 * @param {{
 *   navigate: (path: string) => void,
 *   runAction?: (id: string) => { ok: boolean, reason?: string, error?: string },
 *   pluginEnabled: (id: string) => boolean,
 *   focusGraph: () => void,
 *   notify: (n: { kind: string, message: string }) => void,
 *   t: (key: string) => string,
 *   cardsPending?: () => boolean,
 *   now?: () => number
 * }} deps
 */
export function createShowController({ navigate, runAction, pluginEnabled, focusGraph, notify, t, cardsPending = () => false, now = Date.now }) {
  let last = { view: '', at: -Infinity }
  let lastNav = -Infinity

  function warn(key) {
    try {
      notify({ kind: 'warning', message: t(key) })
    } catch {
      // A notice is a courtesy.
    }
  }

  /**
   * @param {string} view
   * @param {{ byUser?: boolean }} [opts] `byUser`: the person clicked a button themselves. Only that skips the two guards.
   */
  function show(view, { byUser = false } = {}) {
    if (!SHOW_VIEWS.includes(view)) return { ok: false, reason: 'unknown_view' }
    const at = now()
    if (!byUser) {
      // A card waiting for a click is never pushed off screen by the model, and the model cannot shake the screen.
      let pending = true
      try {
        pending = cardsPending() === true
      } catch {
        pending = true // a failed look counts as a card being there
      }
      if (pending) return { ok: false, reason: 'card_pending' }
    }
    if (last.view === view && at - last.at < REPEAT_MS) return { ok: false, reason: 'repeat' }
    if (!byUser && at - lastNav < MIN_GAP_MS) return { ok: false, reason: 'rate_limited' }
    const plan = SHOW_PLAN[view]
    if (plan.needsPlugin && !pluginEnabled(plan.needsPlugin)) {
      warn('show.kanbanOff')
      return { ok: false, reason: 'kanban_off' }
    }
    if (plan.action) {
      let result = null
      try {
        result = typeof runAction === 'function' ? runAction(plan.action) : null
      } catch {
        result = null
      }
      if (!result || result.ok !== true) {
        warn('show.unavailable')
        return { ok: false, reason: 'unavailable' }
      }
    } else {
      navigate(plan.navigate)
      if (plan.focus === 'graph') focusGraph()
    }
    last = { view, at }
    lastNav = at
    return { ok: true, view }
  }

  /** A plugin event frame from Python. Replayed frames are history and never move the screen. */
  function showFromEvent(event) {
    if (event && event.replayed === true) return { ok: false, reason: 'replayed' }
    const view = validateShow(event && event.payload)
    if (!view) return { ok: false, reason: 'unknown_view' }
    return show(view)
  }

  return { show, showFromEvent }
}
