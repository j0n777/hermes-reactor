import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import { SHOW_EVENT, SHOW_PLAN, SHOW_VIEWS, createShowController, validateShow } from '../../src/model/screens.js'

describe('the closed list', () => {
  it('is the same list as the Python tool', () => {
    const py = readFileSync(new URL('../../reactor_hermes/screens.py', import.meta.url), 'utf8')
    const listed = /VIEWS = \(([^)]*)\)/.exec(py)[1].split(',').map(s => s.trim().replace(/"/g, '')).filter(Boolean)
    expect(SHOW_VIEWS).toEqual(listed)
    expect(Object.keys(SHOW_PLAN)).toEqual(listed)
  })

  it('listens to the plugin event the Python side sends', () => {
    expect(SHOW_EVENT).toBe('plugin.hermes-reactor.show')
  })

  it('only maps to routes of this plugin, kanban, or app actions the SDK allows', () => {
    const allowed = new Set(['nav.agents', 'nav.profiles', 'nav.cron', 'nav.messaging', 'nav.capabilities'])
    for (const plan of Object.values(SHOW_PLAN)) {
      if (plan.action) expect(allowed.has(plan.action)).toBe(true)
      if (plan.navigate) expect(['/reactor', '/kanban']).toContain(plan.navigate)
    }
  })

  it('never uses the core /command-center route', () => {
    expect(JSON.stringify(SHOW_PLAN)).not.toContain('command-center')
  })
})

describe('validateShow', () => {
  it.each(SHOW_VIEWS)('accepts %s', view => expect(validateShow({ view })).toBe(view))
  it.each([[null], [undefined], [{}], [{ view: 'settings' }], [{ view: 'Stage' }], [{ view: ' stage' }], [{ view: ['stage'] }], [{ view: 5 }], ['stage'], [{ view: '__proto__' }], [{ view: 'constructor' }]])(
    'refuses %j',
    payload => expect(validateShow(payload)).toBeNull()
  )
})

function setup({ kanban = true, action = () => ({ ok: true }), now = 1_000_000 } = {}) {
  const calls = []
  let clock = now
  const ctl = createShowController({
    navigate: path => calls.push(['navigate', path]),
    runAction: action === null ? undefined : id => { calls.push(['action', id]); return action(id) },
    pluginEnabled: id => (id === 'kanban' ? kanban : false),
    focusGraph: () => calls.push(['focusGraph']),
    notify: n => calls.push(['notify', n.kind]),
    t: key => key,
    now: () => clock
  })
  return { ctl, calls, tick: ms => { clock += ms } }
}

describe('the show controller', () => {
  it('opens the stage and the graph on this plugin\'s own page', () => {
    const s = setup()
    expect(s.ctl.show('stage').ok).toBe(true)
    s.tick(5000)
    expect(s.ctl.show('graph').ok).toBe(true)
    expect(s.calls).toEqual([['navigate', '/reactor'], ['navigate', '/reactor'], ['focusGraph']])
  })

  it('runs the allowed app actions by id', () => {
    const s = setup()
    for (const [view, id] of [['agents', 'nav.agents'], ['profiles', 'nav.profiles'], ['cron', 'nav.cron'], ['messaging', 'nav.messaging'], ['capabilities', 'nav.capabilities']]) {
      s.tick(5000)
      expect(s.ctl.show(view).ok).toBe(true)
      expect(s.calls.at(-1)).toEqual(['action', id])
    }
  })

  it('an unknown view does nothing at all, not even a notice', () => {
    const s = setup()
    expect(s.ctl.showFromEvent({ type: SHOW_EVENT, payload: { view: 'delete-everything' } })).toEqual({ ok: false, reason: 'unknown_view' })
    expect(s.calls).toEqual([])
  })

  it('kanban absent gives a friendly notice and does not navigate', () => {
    const s = setup({ kanban: false })
    expect(s.ctl.show('kanban')).toEqual({ ok: false, reason: 'kanban_off' })
    expect(s.calls).toEqual([['notify', 'warning']])
  })

  it('kanban present navigates', () => {
    const s = setup({ kanban: true })
    expect(s.ctl.show('kanban').ok).toBe(true)
    expect(s.calls).toEqual([['navigate', '/kanban']])
  })

  it('a refused or missing runAction becomes a notice, never an exception', () => {
    expect(setup({ action: () => ({ ok: false, reason: 'unavailable', error: 'x' }) }).ctl.show('cron')).toEqual({ ok: false, reason: 'unavailable' })
    const old = setup({ action: null })
    expect(old.ctl.show('cron')).toEqual({ ok: false, reason: 'unavailable' })
    expect(old.calls).toEqual([['notify', 'warning']])
    const throwing = setup({ action: () => { throw new Error('boom') } })
    expect(throwing.ctl.show('cron').ok).toBe(false)
  })

  it('replayed events never navigate', () => {
    const s = setup()
    expect(s.ctl.showFromEvent({ type: SHOW_EVENT, replayed: true, payload: { view: 'stage' } })).toEqual({ ok: false, reason: 'replayed' })
    expect(s.calls).toEqual([])
  })

  it('the same view twice within two seconds is ignored (a looping model cannot pin the screen)', () => {
    const s = setup()
    s.ctl.show('stage')
    expect(s.ctl.show('stage')).toEqual({ ok: false, reason: 'repeat' })
    s.tick(3000)
    expect(s.ctl.show('stage').ok).toBe(true)
    expect(s.calls.filter(c => c[0] === 'navigate')).toHaveLength(2)
  })

  it('a click on a directive button navigates through the same path, but a bare render never does', () => {
    const s = setup()
    expect(s.calls).toEqual([])
    expect(s.ctl.show('graph', { source: 'click' }).ok).toBe(true)
  })
})
