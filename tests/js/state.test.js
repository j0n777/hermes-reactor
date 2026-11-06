import { describe, expect, it } from 'vitest'
import { REACTOR_STATES, TIMING, initialState, reduce, selectError, selectHeard, selectReactorState } from '../../src/model/state.js'

const open = (state = initialState()) => reduce(state, { type: 'host', patch: { gateway: 'open' } })
const run = (state, ...actions) => actions.reduce((s, a) => reduce(s, a), state)
const sel = (state, now) => selectReactorState(state, now)

describe('reactor state selection', () => {
  it('is offline until the gateway is open', () => {
    expect(sel(initialState(), 0)).toBe('offline')
    expect(sel(open(), 0)).toBe('idle')
    expect(sel(reduce(open(), { type: 'host', patch: { gateway: 'connecting' } }), 0)).toBe('offline')
  })

  it('follows the voice recorder', () => {
    let s = run(open(), { type: 'voice.status', state: 'listening', at: 100 })
    expect(sel(s, 200)).toBe('listening')
    s = reduce(s, { type: 'voice.status', state: 'transcribing', at: 300 })
    expect(sel(s, 400)).toBe('transcribing')
    s = reduce(s, { type: 'voice.transcript', text: 'run the tests', at: 500 })
    expect(sel(s, 600)).toBe('idle')
  })

  it('does not stay in listening forever if idle never arrives', () => {
    const s = run(open(), { type: 'voice.status', state: 'listening', at: 0 })
    expect(sel(s, TIMING.voiceStaleMs - 1)).toBe('listening')
    expect(sel(s, TIMING.voiceStaleMs + 1)).toBe('idle')
  })

  it('goes thinking on turn start and responding on text', () => {
    let s = run(open(), { type: 'turn.start', sessionId: 'a', at: 10 })
    expect(sel(s, 20)).toBe('thinking')
    s = reduce(s, { type: 'turn.delta', sessionId: 'a', at: 30 })
    expect(sel(s, 40)).toBe('responding')
    s = reduce(s, { type: 'turn.thinking', sessionId: 'a', at: 50 })
    expect(sel(s, 60)).toBe('thinking')
    s = reduce(s, { type: 'turn.complete', sessionId: 'a', status: 'complete', at: 70 })
    expect(sel(s, 80)).toBe('idle')
  })

  it('uses host busy as thinking when no event was seen', () => {
    const s = reduce(open(), { type: 'host', patch: { busy: true } })
    expect(sel(s, 5)).toBe('thinking')
    expect(sel(reduce(s, { type: 'host', patch: { busy: false, awaiting: true } }), 5)).toBe('thinking')
  })

  it('prefers the focused session, else the most recent active one', () => {
    let s = run(open(), { type: 'host', patch: { focusedSessionId: 'f' } },
      { type: 'turn.start', sessionId: 'other', at: 10 },
      { type: 'turn.delta', sessionId: 'f', at: 20 })
    expect(sel(s, 30)).toBe('responding')
    s = run(open(), { type: 'turn.start', sessionId: 'x', at: 10 }, { type: 'turn.delta', sessionId: 'y', at: 20 })
    expect(sel(s, 30)).toBe('responding')
  })

  it('drops a stuck phase after the stale window', () => {
    const s = run(open(), { type: 'turn.start', sessionId: 'a', at: 0 })
    expect(sel(s, TIMING.phaseStaleMs + 1)).toBe('idle')
  })

  it('shows error for a failed turn, then clears with time or a new turn', () => {
    let s = run(open(), { type: 'turn.complete', sessionId: 'a', status: 'error', failure: 'rate limit', at: 100 })
    expect(sel(s, 200)).toBe('error')
    expect(selectError(s, 200).message).toBe('rate limit')
    expect(sel(s, 100 + TIMING.errorShowMs + 1)).toBe('idle')
    expect(selectError(s, 100 + TIMING.errorShowMs + 1)).toBeNull()
    s = reduce(s, { type: 'turn.start', sessionId: 'a', at: 300 })
    expect(sel(s, 310)).toBe('thinking')
  })

  it('shows error for an error event and clears when listening starts', () => {
    let s = run(open(), { type: 'error', sessionId: '', message: 'x', at: 100 })
    expect(sel(s, 110)).toBe('error')
    s = reduce(s, { type: 'voice.status', state: 'listening', at: 120 })
    expect(sel(s, 130)).toBe('listening')
  })

  it('an interrupted turn is not an error', () => {
    const s = run(open(), { type: 'turn.start', sessionId: 'a', at: 1 }, { type: 'turn.complete', sessionId: 'a', status: 'interrupted', at: 2 })
    expect(sel(s, 3)).toBe('idle')
  })

  it('approval wins over everything but offline', () => {
    let s = run(open(), { type: 'turn.start', sessionId: 'a', at: 1 },
      { type: 'approval.request', sessionId: 'a', requestId: 'r1', command: 'rm -rf x', at: 2 })
    expect(sel(s, 3)).toBe('approval')
    s = reduce(s, { type: 'host', patch: { gateway: 'idle' } })
    expect(sel(s, 3)).toBe('offline')
  })
})

describe('no speaking state and no audio level', () => {
  it('has no speaking reactor state', () => {
    expect(REACTOR_STATES).not.toContain('speaking')
  })
  it('ignores a stray speaking action', () => {
    const s = run(open(), { type: 'signal.speaking', active: true, at: 5 })
    expect(sel(s, 6)).toBe('idle')
  })
  it('has no audio level field anywhere in the state', () => {
    expect(JSON.stringify(initialState()).toLowerCase()).not.toMatch(/level|amplitude|volume|meter/)
  })
})

describe('wake word listening window', () => {
  it('enters listening on wake.detected and stays until a turn starts', () => {
    const s = run(open(), { type: 'wake', at: 1000 })
    expect(sel(s, 1500)).toBe('listening')
    expect(sel(s, 1000 + TIMING.wakeListenMs - 1)).toBe('listening')
    const t = reduce(s, { type: 'turn.start', sessionId: 'a', at: 4000 })
    expect(sel(t, 4100)).toBe('thinking')
  })
  it('returns to idle after the bounded timeout when no turn follows', () => {
    const s = run(open(), { type: 'wake', at: 1000 })
    expect(sel(s, 1000 + TIMING.wakeListenMs + 1)).toBe('idle')
  })
  it('a voice.status noise event does not extend or break it', () => {
    const s = run(open(), { type: 'wake', at: 1000 }, { type: 'voice.status', state: 'idle', at: 1100 })
    expect(sel(s, 1200)).toBe('listening')
  })
})

describe('heard text', () => {
  it('shows recent partial and transcript text only', () => {
    let s = run(open(), { type: 'voice.partial', text: 'run the', at: 100 })
    expect(selectHeard(s, 200)).toEqual({ text: 'run the', final: false })
    s = reduce(s, { type: 'voice.transcript', text: 'run the tests', at: 300 })
    expect(selectHeard(s, 400)).toEqual({ text: 'run the tests', final: true })
    expect(selectHeard(s, 300 + TIMING.heardShowMs + 1)).toBeNull()
  })
})

describe('feed', () => {
  it('records transitions, bounded', () => {
    let s = open()
    for (let i = 0; i < 20; i += 1) s = reduce(s, { type: 'wake', at: i * 1000 })
    expect(s.feed.length).toBe(TIMING.feedMax)
  })
  it('does not flood on repeated deltas', () => {
    let s = run(open(), { type: 'turn.start', sessionId: 'a', at: 1 })
    for (let i = 0; i < 50; i += 1) s = reduce(s, { type: 'turn.delta', sessionId: 'a', at: 2 + i })
    expect(s.feed.filter(f => f.kind === 'responding').length).toBe(1)
  })
  it('never stores text from the user or from commands', () => {
    const s = run(open(), { type: 'voice.transcript', text: 'secret words', at: 1 },
      { type: 'approval.request', sessionId: 'a', requestId: 'r', command: 'cat /secret', at: 2 })
    expect(JSON.stringify(s.feed)).not.toContain('secret')
  })
})

describe('approvals in state', () => {
  const req = (over = {}) => ({ type: 'approval.request', sessionId: 's', requestId: 'r1', command: 'npm test', description: 'tests', choices: ['once', 'deny'], at: 10, ...over })

  it('adds a card once, even if the event is replayed', () => {
    const s = run(open(), req(), req())
    expect(s.approvals.length).toBe(1)
    expect(s.approvals[0]).toMatchObject({ sessionId: 's', requestId: 'r1', status: 'pending' })
  })
  it('ignores a request without ids', () => {
    expect(run(open(), req({ requestId: '' })).approvals.length).toBe(0)
    expect(run(open(), req({ sessionId: '' })).approvals.length).toBe(0)
  })
  it('settled removes the card and a late replay does not bring it back', () => {
    let s = run(open(), req())
    s = reduce(s, { type: 'approval.settled', requestId: 'r1', at: 20 })
    expect(s.approvals.length).toBe(0)
    s = reduce(s, req({ at: 30 }))
    expect(s.approvals.length).toBe(0)
  })
  it('cancelled removes the listed requests only', () => {
    let s = run(open(), req(), req({ requestId: 'r2' }))
    s = reduce(s, { type: 'approval.cancelled', sessionId: 's', requestIds: ['r1'], count: 1, at: 20 })
    expect(s.approvals.map(c => c.requestId)).toEqual(['r2'])
  })
  it('cancelled without ids drops the whole session when something was cancelled', () => {
    let s = run(open(), req(), req({ requestId: 'r2' }), req({ sessionId: 'other', requestId: 'r3' }))
    s = reduce(s, { type: 'approval.cancelled', sessionId: 's', requestIds: [], count: 2, at: 20 })
    expect(s.approvals.map(c => c.requestId)).toEqual(['r3'])
    expect(reduce(s, { type: 'approval.cancelled', sessionId: 'zzz', requestIds: [], count: 0, at: 30 })).toBe(s)
  })
  it('sync replaces the list for that session only', () => {
    let s = run(open(), req(), req({ requestId: 'r2' }), req({ sessionId: 'other', requestId: 'r3' }))
    s = reduce(s, { type: 'approval.sync', sessionId: 's', items: [{ requestId: 'r2', command: 'x', description: '', choices: ['once', 'deny'], toolName: '', hasEdit: false }, { requestId: 'r9', command: 'y', description: '', choices: [], toolName: '', hasEdit: false }], at: 40 })
    expect(s.approvals.map(c => c.requestId).sort()).toEqual(['r2', 'r3', 'r9'])
  })
  it('sync keeps a card that is being sent', () => {
    let s = run(open(), req())
    const key = s.approvals[0].key
    s = reduce(s, { type: 'approval.sending', key, choice: 'once' })
    s = reduce(s, { type: 'approval.sync', sessionId: 's', items: [], at: 50 })
    expect(s.approvals.length).toBe(1)
  })
  it('sending, failed and answered change the card status', () => {
    let s = run(open(), req())
    const key = s.approvals[0].key
    s = reduce(s, { type: 'approval.sending', key, choice: 'once' })
    expect(s.approvals[0].status).toBe('sending')
    s = reduce(s, { type: 'approval.failed', key, reason: 'timeout' })
    expect(s.approvals[0]).toMatchObject({ status: 'failed', failure: 'timeout' })
    s = reduce(s, { type: 'approval.answered', key, at: 60 })
    expect(s.approvals.length).toBe(0)
  })
  it('a content refresh keeps the in-flight status', () => {
    let s = run(open(), req())
    const key = s.approvals[0].key
    s = reduce(s, { type: 'approval.sending', key, choice: 'once' })
    s = reduce(s, req({ at: 99 }))
    expect(s.approvals[0].status).toBe('sending')
  })
})
