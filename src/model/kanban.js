// Kanban, read only. Python forwards four observer hooks as plugin events (ids, assignee and a state; never task prose). This
// file keeps the latest worker state per task, drives a one-line status on the stage and the label on a Kanban card.
// Nothing here writes to the board or reads its text.
//
// Honest limit: the states are what Reactor has SEEN since this window connected. A task claimed before then, or in a
// process with no Desktop window, has no badge.

import { dict, dictFrom, ownGet, put } from './dict.js'
import { cleanText } from './sanitize.js'

const PREFIX = 'plugin.hermes-reactor.kanban.'
const KINDS = Object.freeze(['claimed', 'completed', 'blocked', 'updated'])
export const KANBAN_EVENTS = Object.freeze(KINDS.map(k => PREFIX + k))
export const LINE_MS = 120_000
export const MAX_TASKS = 200

export function kanbanInitial() {
  return { tasks: dict(), last: null }
}

const str = (value, max) => (typeof value === 'string' ? cleanText(value, max) : '')

export function toKanbanAction(event, now) {
  if (!event || typeof event !== 'object' || event.replayed === true) return null
  const type = typeof event.type === 'string' ? event.type : ''
  if (!type.startsWith(PREFIX)) return null
  const kind = type.slice(PREFIX.length)
  if (!KINDS.includes(kind)) return null
  const p = event.payload && typeof event.payload === 'object' ? event.payload : {}
  const taskId = str(p.task_id, 64)
  if (!taskId) return null
  return { type: 'kanban.event', kind, taskId, assignee: str(p.assignee, 48), profile: str(p.profile, 48), board: str(p.board, 48), at: now }
}

export function kanbanReduce(state, action) {
  if (action.type !== 'kanban.event') return state
  const prev = state.tasks[action.taskId] ?? null
  // `updated` is a field edit: it never changes who is working.
  const next = action.kind === 'updated' ? prev?.state ?? 'updated' : action.kind
  const task = { id: action.taskId, state: next, assignee: action.assignee || prev?.assignee || '', profile: action.profile || prev?.profile || '', board: action.board || prev?.board || '', at: action.at }
  let tasks = put(state.tasks, action.taskId, task)
  const ids = Object.keys(tasks)
  if (ids.length > MAX_TASKS) {
    const rank = t => (t.state === 'claimed' || t.state === 'blocked' ? 1 : 0)
    const drop = ids.sort((a, b) => rank(tasks[a]) - rank(tasks[b]) || tasks[a].at - tasks[b].at).slice(0, ids.length - MAX_TASKS)
    tasks = dictFrom(Object.entries(tasks).filter(([id]) => !drop.includes(id)))
  }
  return { tasks, last: { kind: action.kind, taskId: action.taskId, assignee: task.assignee, profile: task.profile, at: action.at } }
}

/** The status line: the latest change while it is recent, with live counts. Null until something was seen. */
export function selectKanbanLine(state, now) {
  if (!state.last) return null
  const states = Object.values(state.tasks)
  const working = states.filter(t => t.state === 'claimed').length
  const blocked = states.filter(t => t.state === 'blocked').length
  const fresh = now - state.last.at <= LINE_MS
  return { kind: fresh ? state.last.kind : '', taskId: state.last.taskId, assignee: state.last.assignee, profile: state.last.profile, working, blocked }
}

const LABELS = {
  en: { claimed: 'Reactor: working', completed: 'Reactor: done', blocked: 'Reactor: blocked', updated: 'Reactor: edited' },
  'pt-BR': { claimed: 'Reactor: trabalhando', completed: 'Reactor: concluído', blocked: 'Reactor: bloqueado', updated: 'Reactor: editado' }
}
const TONES = { claimed: 'cyan', completed: 'green', blocked: 'red', updated: 'neutral' }
const TIPS = {
  en: who => `Worker state seen by Reactor (read only)${who}`,
  'pt-BR': who => `Estado do worker visto pelo Reactor (somente leitura)${who}`
}

/** The badge for one Kanban card (`KANBAN_CARD_AREAS.badges` decorate). Null for a card never seen. */
export function badgeFor(state, card, locale = 'en') {
  if (!card || typeof card.id !== 'string' || !state.tasks[card.id]) return null
  const task = state.tasks[card.id]
  const tongue = ownGet(LABELS, locale) ? locale : 'en'
  const who = task.assignee ? `: ${task.assignee}${task.profile ? ` (${task.profile})` : ''}` : ''
  return { label: ownGet(LABELS[tongue], task.state) ?? LABELS[tongue].updated, tone: ownGet(TONES, task.state) ?? 'neutral', tooltip: TIPS[tongue](who).slice(0, 160) }
}
