// Reactor for Hermes: the Desktop half. Built into desktop/plugin.js by scripts/build.mjs.
//
// SDK names used here were checked against apps/desktop/src/sdk/index.ts (Hermes 0.23.0):
//   host.request, host.navigate, host.notify, host.state.{gateway,busy,awaitingResponse,
//   focusedSessionId,activeSessionId,focusedSessionProfile}, host.composer.{insertText,focus},
//   host.profiles.list, host.profileRoutes, host.requestProfile, host.retainProfile, host.pluginDecisions,
//   KANBAN_CARD_AREAS.badges, ctx.runAction (view and navigation actions only),
//   PANES_AREA, ROUTES_AREA, SIDEBAR_NAV_AREA, STATUSBAR_AREAS, PALETTE_AREA,
//   TRANSCRIPT_DIRECTIVE_AREA, APPROVAL_RESPOND_TIMEOUT_MS, useI18n,
//   ctx.register, ctx.registerMany, ctx.onEvent, ctx.onDispose, ctx.setTimeout,
//   ctx.setInterval, ctx.storage.{get,set}, ctx.rest (this plugin's own /api/plugins/hermes-reactor backend).
// No network access, no eval, no dynamic import, no script injection, no queries into
// Hermes' own markup. The only DOM it touches is its own <style> element.

import {
  APPROVAL_RESPOND_TIMEOUT_MS,
  KANBAN_CARD_AREAS,
  PALETTE_AREA,
  PANES_AREA,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS,
  TRANSCRIPT_DIRECTIVE_AREA,
  host
} from '@hermes/plugin-sdk'

import { badgeFor } from './model/kanban.js'
import { createRuntime } from './runtime.js'
import { CSS } from './styles.js'
import { SessionCard } from './views/SessionCard.js'
import { ShowCard } from './views/ShowCard.js'
import { AgentsPane, ReactorPane, StagePage, StatusItem } from './views/StagePage.js'
import { h } from './views/h.js'
import { setRuntime } from './views/hooks.js'

const PAGE_PATH = '/reactor'
const STYLE_ID = 'hermes-reactor-style'

function installStyle(ctx) {
  const existing = document.getElementById(STYLE_ID)
  if (existing) existing.remove()
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.append(style)
  ctx.onDispose(() => style.remove())
}

export default {
  id: 'hermes-reactor',
  name: 'Reactor',
  description: 'A live graph of your profiles and subagents, a reactor that shows what Hermes is doing, and cards that wait for your click.',
  register(ctx) {
    installStyle(ctx)

    const runtime = createRuntime({
      request: (method, params, timeoutMs) => host.request(method, params, timeoutMs),
      rest: (path, opts) => ctx.rest(path, opts),
      onEvent: (type, fn) => ctx.onEvent(type, fn),
      setTimeout: (fn, ms) => ctx.setTimeout(fn, ms),
      setInterval: (fn, ms) => ctx.setInterval(fn, ms),
      storage: ctx.storage,
      hostState: host.state,
      notify: n => host.notify(n),
      composer: host.composer,
      navigate: path => host.navigate(path),
      runAction: id => (typeof ctx.runAction === 'function' ? ctx.runAction(id) : { ok: false, reason: 'unavailable', error: 'ctx.runAction is missing' }),
      pluginEnabled: id => {
        try {
          return host.pluginDecisions.get()[id] === true
        } catch {
          return false
        }
      },
      listProfiles: () => host.profiles.list(),
      profileRoutes: () => host.profileRoutes(),
      requestProfile: (route, method, params, timeoutMs, options) => host.requestProfile(route, method, params, timeoutMs, options),
      retainProfile: typeof host.retainProfile === 'function' ? (route, options) => host.retainProfile(route, options) : undefined,
      onKanbanChange: () => scheduleBadgeRefresh(),
      approvalTimeoutMs: APPROVAL_RESPOND_TIMEOUT_MS,
      isVisible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
    })
    setRuntime(runtime)

    // Kanban card badges: the board asks `decorate` while it renders, so a changed worker state needs the contribution to be
    // registered again (same id replaces it). Throttled to once a second.
    let badgeTimer = null
    function registerBadges() {
      ctx.register({
        id: 'kanban-badges',
        area: KANBAN_CARD_AREAS.badges,
        data: { decorate: card => badgeFor(runtime.kanban.getState(), card, runtime.getLocale()) }
      })
    }
    function scheduleBadgeRefresh() {
      if (badgeTimer) return
      badgeTimer = ctx.setTimeout(() => {
        badgeTimer = null
        registerBadges()
      }, 1000)
    }
    registerBadges()
    ctx.onDispose(runtime.start())

    ctx.registerMany([
      { id: 'page', area: ROUTES_AREA, data: { path: PAGE_PATH }, render: () => h(StagePage, null) },
      { id: 'nav', area: SIDEBAR_NAV_AREA, data: { path: PAGE_PATH, label: 'Reactor', codicon: 'pulse' } },
      { id: 'pane', area: PANES_AREA, title: 'Reactor', data: { placement: 'right', width: '340px' }, render: () => h(ReactorPane, null) },
      { id: 'agents', area: PANES_AREA, title: 'Agents', data: { placement: 'right', width: '340px' }, render: () => h(AgentsPane, null) },
      { id: 'status', area: STATUSBAR_AREAS.right, order: 90, render: () => h(StatusItem, null) },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: { id: 'reactor.open', label: 'Open Reactor', keywords: ['reactor', 'hermes', 'agents', 'approvals', 'abrir'], run: () => host.navigate(PAGE_PATH) }
      },
      {
        id: 'session-card',
        area: TRANSCRIPT_DIRECTIVE_AREA,
        data: { name: 'reactor-session', render: ({ attrs, sessionId }) => h(SessionCard, { attrs, sessionId }) }
      },
      {
        id: 'show-card',
        area: TRANSCRIPT_DIRECTIVE_AREA,
        data: { name: 'reactor-show', render: ({ attrs }) => h(ShowCard, { attrs }) }
      }
    ])
  }
}
