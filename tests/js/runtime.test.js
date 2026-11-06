import { describe, expect, it, vi } from 'vitest'

import { createRuntime } from '../../src/runtime.js'
import { makeT } from '../../src/model/i18n.js'
import { selectReactorState } from '../../src/model/state.js'
import { WATCHED_EVENT_TYPES } from '../../src/model/events.js'

const t = makeT('en')

function manualAtom(initial) {
  let value = initial
  const subs = new Set()
  return {
    get: () => value,
    subscribe(fn) { subs.add(fn); fn(value); return () => subs.delete(fn) },
    set(next) { value = next; for (const fn of [...subs]) fn(value) },
    count: () => subs.size
  }
}

function setup(over = {}) {
  const handlers = new Map()
  const timers = []
  const hostState = {
    gateway: manualAtom('open'),
    busy: manualAtom(false),
    awaitingResponse: manualAtom(false),
    focusedSessionId: manualAtom('s1'),
    activeSessionId: manualAtom('s1')
  }
  const request = vi.fn(async method => {
    if (method === 'session.foreign.list') return { sessions: [], next_offset: null, host: 'h' }
    if (method === 'approval.pending') return { approvals: [] }
    return {}
  })
  const composer = { insertText: vi.fn(async () => true), focus: vi.fn() }
  const notify = vi.fn()
  let clockNow = 1_000_000
  const rt = createRuntime({
    request,
    onEvent: (type, fn) => { handlers.set(type, fn); return () => handlers.delete(type) },
    setTimeout: (fn, ms) => { const entry = { fn, ms, cancelled: false }; timers.push(entry); return () => { entry.cancelled = true } },
    setInterval: vi.fn(() => () => {}),
    storage: { get: (k, d) => d, set: vi.fn() },
    hostState,
    notify,
    composer,
    navigate: vi.fn(),
    approvalTimeoutMs: 330000,
    now: () => clockNow,
    ...over
  })
  const emit = (type, payload, extra = {}) => handlers.get(type)?.({ type, payload, session_id: 's1', ...extra })
  return { rt, handlers, timers, hostState, request, composer, notify, emit, advance: ms => { clockNow += ms } }
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('wiring', () => {
  it('subscribes to every watched event and to the host atoms', () => {
    const { rt, handlers, hostState } = setup()
    rt.start()
    for (const type of WATCHED_EVENT_TYPES) expect(handlers.has(type), type).toBe(true)
    expect(rt.store.getState().host.gateway).toBe('open')
    expect(hostState.gateway.count()).toBe(1)
  })

  it('stop() removes every subscription', () => {
    const { rt, handlers, hostState } = setup()
    rt.start()
    rt.stop()
    expect(handlers.size).toBe(0)
    expect(hostState.gateway.count()).toBe(0)
    expect(hostState.busy.count()).toBe(0)
  })

  it('start() twice does not double-subscribe', () => {
    const { rt, hostState } = setup()
    rt.start()
    rt.start()
    expect(hostState.gateway.count()).toBe(1)
  })

  it('turns gateway events into the reactor state', () => {
    const { rt, emit } = setup()
    rt.start()
    const now = () => rt.now()
    emit('voice.status', { state: 'listening' })
    expect(selectReactorState(rt.store.getState(), now())).toBe('listening')
    emit('voice.status', { state: 'idle' })
    emit('message.start', {})
    expect(selectReactorState(rt.store.getState(), now())).toBe('thinking')
    emit('message.delta', { text: 'hi' })
    expect(selectReactorState(rt.store.getState(), now())).toBe('responding')
    emit('message.complete', { status: 'complete' })
    expect(selectReactorState(rt.store.getState(), now())).toBe('idle')
  })

  it('shows and clears an approval from events', () => {
    const { rt, emit } = setup()
    rt.start()
    emit('approval.request', { prompt_id: 'p1', command: 'make x', choices: ['once', 'deny'] })
    expect(rt.store.getState().approvals.length).toBe(1)
    emit('approval.settled', { prompt_id: 'p1' })
    expect(rt.store.getState().approvals.length).toBe(0)
  })

  it('follows the gateway atom: offline and back', () => {
    const { rt, hostState } = setup()
    rt.start()
    hostState.gateway.set('closed')
    expect(selectReactorState(rt.store.getState(), rt.now())).toBe('offline')
    hostState.gateway.set('open')
    expect(selectReactorState(rt.store.getState(), rt.now())).toBe('idle')
  })
})

describe('approvals on load and reconnect', () => {
  it('asks approval.pending for the focused session on start', async () => {
    const { rt, request } = setup()
    rt.start()
    await flush()
    expect(request).toHaveBeenCalledWith('approval.pending', { session_id: 's1' })
  })

  it('asks again when the gateway reopens', async () => {
    const { rt, request, hostState } = setup()
    rt.start()
    await flush()
    request.mockClear()
    hostState.gateway.set('closed')
    hostState.gateway.set('open')
    await flush()
    expect(request).toHaveBeenCalledWith('approval.pending', { session_id: 's1' })
  })

  it('asks when the focused chat changes', async () => {
    const { rt, request, hostState } = setup()
    rt.start()
    await flush()
    request.mockClear()
    hostState.focusedSessionId.set('s2')
    await flush()
    expect(request).toHaveBeenCalledWith('approval.pending', { session_id: 's2' })
  })

  it('polls approvals no faster than every 4 seconds', async () => {
    const { rt, timers } = setup()
    rt.start()
    await flush()
    const delays = timers.filter(x => !x.cancelled).map(x => x.ms)
    expect(delays.length).toBeGreaterThan(0)
    for (const ms of delays) expect(ms).toBeGreaterThanOrEqual(4000)
  })

  it('never answers anything by itself', async () => {
    const { rt, request, emit } = setup()
    rt.start()
    emit('approval.request', { prompt_id: 'p1', command: 'ls', choices: ['once', 'deny'] })
    await flush()
    expect(request.mock.calls.some(c => c[0] === 'approval.respond')).toBe(false)
  })
})

describe('agents list', () => {
  it('does nothing until a view is on screen, then lists once, then polls politely', async () => {
    const { rt, request, timers } = setup()
    rt.start()
    await flush()
    expect(request.mock.calls.filter(c => c[0] === 'session.foreign.list').length).toBe(0)
    const release = rt.retainAgents()
    await flush()
    expect(request).toHaveBeenCalledWith('session.foreign.list', { offset: 0, limit: 50 })
    const agentTimers = timers.filter(x => !x.cancelled && x.ms >= 30000)
    expect(agentTimers.length).toBeGreaterThan(0)
    release()
    expect(timers.filter(x => !x.cancelled && x.ms >= 30000).length).toBeLessThan(agentTimers.length + 1)
  })

  it('stops polling when the last view goes away', async () => {
    const { rt, timers } = setup()
    rt.start()
    const a = rt.retainAgents()
    const b = rt.retainAgents()
    await flush()
    a()
    expect(timers.some(x => !x.cancelled && x.ms === 30000)).toBe(true)
    b()
    expect(timers.some(x => !x.cancelled && x.ms === 30000)).toBe(false)
  })

  it('does not list while the gateway is not open, and refreshes when it opens', async () => {
    const { rt, request, hostState } = setup()
    hostState.gateway.set('closed')
    rt.start()
    rt.retainAgents()
    await flush()
    expect(request.mock.calls.filter(c => c[0] === 'session.foreign.list').length).toBe(0)
    hostState.gateway.set('open')
    await flush()
    expect(request.mock.calls.filter(c => c[0] === 'session.foreign.list').length).toBe(1)
  })

  it('records an error from the gateway and recovers', async () => {
    let fail = true
    const { rt, request } = setup()
    request.mockImplementation(async method => {
      if (method === 'session.foreign.list') {
        if (fail) throw new Error('Could not read session folders on this backend')
        return { sessions: [{ id: 'a'.repeat(64), source: 'claude', title: 'T', cwd: '/x', mtime: 1, turn_count: 1 }] }
      }
      return { approvals: [] }
    })
    rt.start()
    await rt.refreshAgents()
    expect(rt.agents.getState()).toMatchObject({ status: 'error', error: 'Could not read session folders on this backend' })
    fail = false
    await rt.refreshAgents()
    expect(rt.agents.getState().status).toBe('ready')
  })

  it('treats a malformed reply as an error, not as an empty list', async () => {
    const { rt, request } = setup()
    request.mockImplementation(async () => ({ nope: 1 }))
    rt.start()
    await rt.refreshAgents()
    expect(rt.agents.getState().status).toBe('error')
  })
})

describe('briefSession', () => {
  const row = { id: 'a'.repeat(64), source: 'claude', title: 'Fix auth', folder: 'api', folderPath: '/work/api', mtimeMs: 1, turns: 3 }

  it('puts a draft in the composer and does not send it', async () => {
    const { rt, composer, notify } = setup()
    expect(await rt.briefSession(row, t, 'chat-1')).toBe(true)
    expect(composer.insertText).toHaveBeenCalledWith('chat-1', expect.stringContaining('Fix auth'), { mode: 'block' })
    expect(composer.focus).toHaveBeenCalledWith('chat-1')
    expect(composer).not.toHaveProperty('submit')
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'info' }))
  })

  it('warns when there is no chat to write into', async () => {
    const { rt, composer, notify } = setup()
    composer.insertText.mockResolvedValue(false)
    expect(await rt.briefSession(row, t)).toBe(false)
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'warning' }))
  })

  it('survives the composer throwing', async () => {
    const { rt, composer, notify } = setup()
    composer.insertText.mockRejectedValue(new Error('x'))
    expect(await rt.briefSession(row, t)).toBe(false)
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'warning' }))
  })
})

describe('clock', () => {
  it('ticks only while someone is subscribed', () => {
    const stop = vi.fn()
    const setInterval = vi.fn(() => stop)
    const { rt } = setup({ setInterval })
    const off1 = rt.clock.subscribe(() => {})
    const off2 = rt.clock.subscribe(() => {})
    expect(setInterval).toHaveBeenCalledTimes(1)
    off1()
    expect(stop).not.toHaveBeenCalled()
    off2()
    expect(stop).toHaveBeenCalledTimes(1)
  })
})

describe('locale preference', () => {
  it('persists an explicit choice and ignores junk', () => {
    const set = vi.fn()
    const { rt } = setup({ storage: { get: (k, d) => (k === 'locale' ? 'pt-BR' : d), set } })
    expect(rt.localePref.get()).toBe('pt-BR')
    rt.localePref.set('en')
    expect(set).toHaveBeenCalledWith('locale', 'en')
    rt.localePref.set('klingon')
    expect(rt.localePref.get()).toBe('auto')
  })
  it('survives broken storage', () => {
    const { rt } = setup({ storage: { get: () => { throw new Error('no') }, set: () => { throw new Error('no') } } })
    expect(rt.localePref.get()).toBe('auto')
    expect(() => rt.localePref.set('en')).not.toThrow()
  })
})
