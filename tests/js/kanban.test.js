import { describe, expect, it } from 'vitest'

import { KANBAN_EVENTS, badgeFor, kanbanInitial, kanbanReduce, selectKanbanLine, toKanbanAction } from '../../src/model/kanban.js'

const NOW = 1_700_000_000_000
const ev = (kind, payload = {}, extra = {}) => ({ type: `plugin.hermes-reactor.kanban.${kind}`, session_id: '', payload: { task_id: 't_abc', board: 'main', assignee: 'writer', profile: 'default', run_id: 3, ...payload }, ...extra })
const apply = (s, ...actions) => actions.reduce((st, a) => (a ? kanbanReduce(st, a) : st), s)

describe('events', () => {
  it('knows the four plugin events from the Python side', () => {
    expect(KANBAN_EVENTS).toEqual(['plugin.hermes-reactor.kanban.claimed', 'plugin.hermes-reactor.kanban.completed', 'plugin.hermes-reactor.kanban.blocked', 'plugin.hermes-reactor.kanban.updated'])
  })

  it('maps a frame to an action and cleans the text', () => {
    expect(toKanbanAction(ev('claimed'), NOW)).toEqual({ type: 'kanban.event', kind: 'claimed', taskId: 't_abc', assignee: 'writer', profile: 'default', board: 'main', at: NOW })
    expect(toKanbanAction(ev('claimed', { task_id: 't_‮A​B' }), NOW).taskId).toBe('t_AB')
  })

  it('refuses frames without a task id, unknown kinds, replays and junk', () => {
    expect(toKanbanAction(ev('claimed', { task_id: '' }), NOW)).toBeNull()
    expect(toKanbanAction(ev('claimed', { task_id: 5 }), NOW)).toBeNull()
    expect(toKanbanAction({ type: 'plugin.hermes-reactor.kanban.deleted', payload: { task_id: 't' } }, NOW)).toBeNull()
    expect(toKanbanAction(ev('claimed', {}, { replayed: true }), NOW)).toBeNull()
    expect(toKanbanAction(null, NOW)).toBeNull()
    expect(toKanbanAction({ type: 'plugin.other.kanban.claimed', payload: { task_id: 't' } }, NOW)).toBeNull()
  })
})

describe('state and the status line', () => {
  it('follows a task through claimed, blocked and completed', () => {
    let s = apply(kanbanInitial(), toKanbanAction(ev('claimed'), NOW))
    expect(selectKanbanLine(s, NOW + 1000)).toMatchObject({ kind: 'claimed', taskId: 't_abc', assignee: 'writer', working: 1, blocked: 0 })
    s = apply(s, toKanbanAction(ev('blocked'), NOW + 2000))
    expect(selectKanbanLine(s, NOW + 3000)).toMatchObject({ kind: 'blocked', working: 0, blocked: 1 })
    s = apply(s, toKanbanAction(ev('completed'), NOW + 4000))
    expect(selectKanbanLine(s, NOW + 5000)).toMatchObject({ kind: 'completed', working: 0, blocked: 0 })
  })

  it('the line fades after two minutes but the counts stay honest', () => {
    const s = apply(kanbanInitial(), toKanbanAction(ev('claimed'), NOW))
    expect(selectKanbanLine(s, NOW + 121_000)).toMatchObject({ kind: '', working: 1 })
    expect(selectKanbanLine(kanbanInitial(), NOW)).toBeNull()
  })

  it('an update does not change the worker state', () => {
    let s = apply(kanbanInitial(), toKanbanAction(ev('claimed'), NOW), toKanbanAction(ev('updated'), NOW + 10))
    expect(s.tasks.t_abc.state).toBe('claimed')
    s = apply(kanbanInitial(), toKanbanAction(ev('updated', { task_id: 't_new' }), NOW))
    expect(s.tasks.t_new.state).toBe('updated')
  })

  it('is bounded and keeps the running ones', () => {
    let s = kanbanInitial()
    for (let i = 0; i < 400; i += 1) s = apply(s, toKanbanAction(ev(i % 2 ? 'completed' : 'claimed', { task_id: `t_${i}` }), NOW + i))
    expect(Object.keys(s.tasks).length).toBeLessThanOrEqual(200)
    expect(Object.values(s.tasks).filter(t => t.state === 'claimed').length).toBe(200)
  })
})

describe('card badges', () => {
  const card = id => ({ id, status: 'running', tenant: null, assignee: 'writer' })

  it('shows the worker state of a card it has seen, within the badge limits', () => {
    const s = apply(kanbanInitial(), toKanbanAction(ev('claimed'), NOW), toKanbanAction(ev('completed', { task_id: 't_done' }), NOW), toKanbanAction(ev('blocked', { task_id: 't_stuck' }), NOW))
    const working = badgeFor(s, card('t_abc'))
    expect(working).toMatchObject({ label: 'Reactor: working', tone: 'cyan' })
    expect(working.tooltip).toContain('writer')
    expect(badgeFor(s, card('t_done'))).toMatchObject({ label: 'Reactor: done', tone: 'green' })
    expect(badgeFor(s, card('t_stuck'))).toMatchObject({ label: 'Reactor: blocked', tone: 'red' })
    for (const b of [working, badgeFor(s, card('t_done'))]) {
      expect(b.label.length).toBeLessThanOrEqual(24)
      expect(b.tooltip.length).toBeLessThanOrEqual(160)
    }
  })

  it('says nothing about cards it has not seen, and survives junk', () => {
    const s = kanbanInitial()
    expect(badgeFor(s, card('t_unknown'))).toBeNull()
    expect(badgeFor(s, null)).toBeNull()
    expect(badgeFor(s, { id: 5 })).toBeNull()
    expect(badgeFor(s, { id: '__proto__' })).toBeNull()
  })

  it('the badge text is in Portuguese when asked', () => {
    const s = apply(kanbanInitial(), toKanbanAction(ev('claimed'), NOW))
    expect(badgeFor(s, card('t_abc'), 'pt-BR').label).toBe('Reactor: trabalhando')
  })

  it('updated-only tasks get a neutral badge', () => {
    const s = apply(kanbanInitial(), toKanbanAction(ev('updated'), NOW))
    expect(badgeFor(s, card('t_abc'))).toMatchObject({ tone: 'neutral' })
  })
})
