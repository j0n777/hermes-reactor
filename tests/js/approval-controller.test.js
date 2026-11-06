import { describe, expect, it, vi } from 'vitest'
import { createApprovalController } from '../../src/model/approval-controller.js'
import { initialState, reduce } from '../../src/model/state.js'
import { createStore } from '../../src/model/store.js'

const click = { type: 'click', isTrusted: true, detail: 1 }
const keyboard = { type: 'click', isTrusted: true, detail: 0 }
const fake = { type: 'click', isTrusted: false, detail: 1 }

function setup({ request, command = 'npm test', choices = ['once', 'session', 'always', 'deny'], gateway = 'open' } = {}) {
  const store = createStore(reduce, initialState())
  store.dispatch({ type: 'host', patch: { gateway } })
  store.dispatch({ type: 'approval.request', sessionId: 's1', requestId: 'r1', command, description: 'run tests', choices, at: 1 })
  const req = request ?? vi.fn(async () => ({ resolved: 1 }))
  const controller = createApprovalController({ getState: store.getState, dispatch: store.dispatch, request: req, timeoutMs: 330000, now: () => 5 })
  const key = store.getState().approvals[0].key
  return { store, controller, req, key }
}

describe('answering', () => {
  it('sends approval.respond with the session, request id and choice, then removes the card', async () => {
    const { store, controller, req, key } = setup()
    const out = await controller.answer(key, 'once', click)
    expect(out).toEqual({ ok: true, handled: 'answered' })
    expect(req).toHaveBeenCalledTimes(1)
    expect(req).toHaveBeenCalledWith('approval.respond', { session_id: 's1', request_id: 'r1', choice: 'once' }, 330000)
    expect(store.getState().approvals.length).toBe(0)
  })

  it('never sends "all"', async () => {
    const { controller, req, key } = setup()
    await controller.answer(key, 'once', click)
    expect(req.mock.calls[0][1]).not.toHaveProperty('all')
  })

  it('refuses approving without a real click', async () => {
    for (const event of [keyboard, fake, undefined, null, { type: 'keydown', key: 'Enter', isTrusted: true, detail: 0 }]) {
      const { store, controller, req, key } = setup()
      const out = await controller.answer(key, 'once', event)
      expect(out).toEqual({ ok: false, reason: 'not_a_click' })
      expect(req).not.toHaveBeenCalled()
      expect(store.getState().approvals[0].status).toBe('pending')
    }
  })

  it('allows deny from the keyboard but not from a script', async () => {
    const a = setup()
    expect((await a.controller.answer(a.key, 'deny', keyboard)).ok).toBe(true)
    expect(a.req).toHaveBeenCalledWith('approval.respond', expect.objectContaining({ choice: 'deny' }), 330000)
    const b = setup()
    expect((await b.controller.answer(b.key, 'deny', fake)).reason).toBe('not_a_click')
    expect(b.req).not.toHaveBeenCalled()
  })

  it('a double click sends once', async () => {
    let release
    const request = vi.fn(() => new Promise(resolve => { release = () => resolve({ resolved: 1 }) }))
    const { controller, key } = setup({ request })
    const first = controller.answer(key, 'once', click)
    const second = await controller.answer(key, 'once', click)
    const third = await controller.answer(key, 'deny', click)
    expect(second.reason).toBe('busy')
    expect(third.reason).toBe('busy')
    release()
    await first
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('a different choice while sending cannot override the first', async () => {
    let release
    const request = vi.fn(() => new Promise(resolve => { release = () => resolve({ resolved: 1 }) }))
    const { controller, key } = setup({ request })
    const first = controller.answer(key, 'deny', click)
    expect((await controller.answer(key, 'once', click)).reason).toBe('busy')
    release()
    await first
    expect(request.mock.calls.map(c => c[1].choice)).toEqual(['deny'])
  })

  it('refuses a choice that is not offered (always for a destructive command)', async () => {
    const { controller, req, key } = setup({ command: 'rm -rf /' })
    expect((await controller.answer(key, 'always', click)).reason).toBe('not_offered')
    expect((await controller.answer(key, 'session', click)).reason).toBe('not_offered')
    expect(req).not.toHaveBeenCalled()
  })

  it('refuses a made-up choice', async () => {
    const { controller, req, key } = setup()
    expect((await controller.answer(key, 'yolo', click)).reason).toBe('not_offered')
    expect(req).not.toHaveBeenCalled()
  })

  it('refuses a stale request that is no longer pending', async () => {
    const { store, controller, req, key } = setup()
    store.dispatch({ type: 'approval.settled', requestId: 'r1', at: 9 })
    expect((await controller.answer(key, 'once', click)).reason).toBe('stale')
    expect((await controller.answer('s1::unknown', 'once', click)).reason).toBe('stale')
    expect(req).not.toHaveBeenCalled()
  })

  it('refuses after the request was cancelled', async () => {
    const { store, controller, req, key } = setup()
    store.dispatch({ type: 'approval.cancelled', sessionId: 's1', requestIds: ['r1'], count: 1, at: 9 })
    expect((await controller.answer(key, 'once', click)).reason).toBe('stale')
    expect(req).not.toHaveBeenCalled()
  })

  it('does not answer while the gateway is not open', async () => {
    const { store, controller, req, key } = setup()
    store.dispatch({ type: 'host', patch: { gateway: 'connecting' } })
    expect((await controller.answer(key, 'once', click)).reason).toBe('offline')
    expect(req).not.toHaveBeenCalled()
  })
})

describe('failures', () => {
  it('shows the failure, keeps the card, and allows a deliberate retry', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new Error('request timed out: approval.respond'))
      .mockResolvedValueOnce({ resolved: 1 })
    const { store, controller, key } = setup({ request })
    const first = await controller.answer(key, 'once', click)
    expect(first).toEqual({ ok: false, reason: 'failed' })
    expect(store.getState().approvals[0]).toMatchObject({ status: 'failed', failure: 'request timed out: approval.respond' })
    const retry = await controller.answer(key, 'once', click)
    expect(retry.ok).toBe(true)
    expect(request).toHaveBeenCalledTimes(2)
    expect(store.getState().approvals.length).toBe(0)
  })

  it('sanitises and caps the failure text', async () => {
    const request = vi.fn().mockRejectedValue(new Error('bad‮' + 'x'.repeat(500)))
    const { store, controller, key } = setup({ request })
    await controller.answer(key, 'once', click)
    const reason = store.getState().approvals[0].failure
    expect(reason).not.toContain('‮')
    expect(Array.from(reason).length).toBeLessThanOrEqual(120)
  })

  it('treats resolved 0 as already handled and removes the card', async () => {
    const { store, controller, key } = setup({ request: vi.fn(async () => ({ resolved: 0 })) })
    expect(await controller.answer(key, 'once', click)).toEqual({ ok: true, handled: 'already' })
    expect(store.getState().approvals.length).toBe(0)
  })
})

describe('syncing with approval.pending', () => {
  it('loads cards for a session', async () => {
    const store = createStore(reduce, initialState())
    store.dispatch({ type: 'host', patch: { gateway: 'open' } })
    const request = vi.fn(async () => ({ approvals: [{ request_id: 'p1', command: 'ls', description: 'd', choices: ['once', 'deny'] }, { command: 'no id' }] }))
    const controller = createApprovalController({ getState: store.getState, dispatch: store.dispatch, request, now: () => 3 })
    expect(await controller.syncSession('s1')).toEqual({ ok: true, count: 1 })
    expect(request).toHaveBeenCalledWith('approval.pending', { session_id: 's1' })
    expect(store.getState().approvals.map(c => c.requestId)).toEqual(['p1'])
  })

  it('removes cards the gateway no longer lists', async () => {
    const { store, controller, req } = setup({ request: vi.fn(async () => ({ approvals: [] })) })
    expect(store.getState().approvals.length).toBe(1)
    await controller.syncSession('s1')
    expect(store.getState().approvals.length).toBe(0)
    expect(req).toHaveBeenCalledTimes(1)
  })

  it('keeps cards when the call fails or the reply is malformed', async () => {
    const failing = setup({ request: vi.fn(async () => { throw new Error('x') }) })
    expect((await failing.controller.syncSession('s1')).ok).toBe(false)
    expect(failing.store.getState().approvals.length).toBe(1)
    const bad = setup({ request: vi.fn(async () => ({ nope: true })) })
    expect((await bad.controller.syncSession('s1')).reason).toBe('bad_reply')
    expect(bad.store.getState().approvals.length).toBe(1)
  })

  it('ignores a superseded reply', async () => {
    const releases = []
    const request = vi.fn(() => new Promise(resolve => releases.push(resolve)))
    const { store, controller } = setup({ request })
    const a = controller.syncSession('s1')
    const b = controller.syncSession('s1')
    releases[1]({ approvals: [] })
    releases[0]({ approvals: [{ request_id: 'zzz', command: 'x', choices: ['once', 'deny'] }] })
    expect((await a).reason).toBe('superseded')
    await b
    expect(store.getState().approvals.length).toBe(0)
  })

  it('does not call the gateway when offline or without a session', async () => {
    const { controller, req } = setup({ gateway: 'idle' })
    expect((await controller.syncSession('s1')).reason).toBe('offline')
    expect((await controller.syncSession('')).reason).toBe('no_session')
    expect(req).not.toHaveBeenCalled()
  })

  it('lists the sessions worth syncing', () => {
    const { store, controller } = setup()
    store.dispatch({ type: 'host', patch: { focusedSessionId: 'f1' } })
    expect(controller.sessionsToSync().sort()).toEqual(['f1', 's1'])
  })
})
