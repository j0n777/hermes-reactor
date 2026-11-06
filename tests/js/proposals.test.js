import { describe, expect, it, vi } from 'vitest'

import { makeT } from '../../src/model/i18n.js'
import {
  buttonsFor,
  cardView,
  clockLabel,
  codeKey,
  createProposalController,
  effectiveState,
  normalizeProposal,
  normalizeProposalList,
  proposalsInitial,
  proposalsReduce,
  secondsLeft,
  waitingCount
} from '../../src/model/proposals.js'
import { createStore } from '../../src/model/store.js'

const t = makeT('en')
const ID = 'A'.repeat(32)
const ID2 = 'B'.repeat(32)

const raw = (over = {}) => ({
  id: ID,
  label: 'jc-abc123',
  agent: 'claude',
  ref: '0123456789ab',
  title: 'Fix the auth middleware',
  folder: 'C:\\work\\api',
  instruction: 'run the tests and fix what fails',
  state: 'pending',
  code: '',
  started: false,
  remaining_s: 280,
  started_at: null,
  ended_at: null,
  exit_code: null,
  output: '',
  output_truncated: false,
  runs_under_own_permissions: true,
  ...over
})

const click = (over = {}) => ({ isTrusted: true, type: 'click', detail: 1, ...over })

describe('normalizeProposal', () => {
  it('keeps a good proposal and cleans every outside string', () => {
    const p = normalizeProposal(raw({ title: 'a\u202eb\u0000c', folder: 'C:\\x\u200b\\y', instruction: 'go\u202e\nnow', output: 'ok\u001b[31m' }), 1000)
    expect(p).toMatchObject({ id: ID, agent: 'claude', state: 'pending', receivedAt: 1000, remainingS: 280 })
    expect(p.title).toBe('abc')
    expect(p.folder).toBe('C:\\x\\y')
    expect(p.instruction).toBe('go\nnow')
    expect(p.output).not.toMatch(/\u001b/)
  })
  it.each([
    ['no id', { id: undefined }],
    ['short id', { id: 'abc' }],
    ['id with path chars', { id: '../../etc/passwd/....' }],
    ['long id', { id: 'a'.repeat(100) }],
    ['unknown agent', { agent: 'gemini' }],
    ['unknown state', { state: 'approved' }],
    ['numeric id', { id: 12345678901234567890 }]
  ])('rejects %s', (_name, over) => {
    expect(normalizeProposal(raw(over))).toBeNull()
  })
  it('rejects non-objects', () => {
    for (const v of [null, undefined, 5, 'x', []]) expect(normalizeProposal(v)).toBeNull()
  })
  it('drops a code that is not a plain code', () => {
    expect(normalizeProposal(raw({ code: '<script>alert(1)</script>' })).code).toBe('')
    expect(normalizeProposal(raw({ code: 'folder_changed' })).code).toBe('folder_changed')
  })
  it('bounds a huge instruction and a huge output', () => {
    const p = normalizeProposal(raw({ instruction: 'x'.repeat(50_000), output: 'y\n'.repeat(50_000) }))
    expect(Array.from(p.instruction).length).toBeLessThanOrEqual(4001)
    expect(Array.from(p.output).length).toBeLessThanOrEqual(8001)
    expect(p.output.split('\n').length).toBeLessThanOrEqual(201)
  })
  it('never renders markup: the strings stay plain text', () => {
    const p = normalizeProposal(raw({ instruction: '<img src=x onerror=alert(1)>', title: '<b>x</b>' }))
    expect(p.instruction).toBe('<img src=x onerror=alert(1)>')
    expect(p.title).toBe('<b>x</b>')
  })
})

describe('normalizeProposalList', () => {
  it('needs ok:true and an array', () => {
    expect(normalizeProposalList({ ok: true, proposals: [raw(), { bad: 1 }, raw({ id: ID2 })] }).map(p => p.id)).toEqual([ID, ID2])
    for (const bad of [null, {}, { ok: false, proposals: [] }, { ok: true }, { ok: true, proposals: 'x' }]) {
      expect(normalizeProposalList(bad)).toBeNull()
    }
  })
})

describe('time', () => {
  const item = normalizeProposal(raw({ remaining_s: 10 }), 1_000_000)
  it('counts down from the moment the reply arrived', () => {
    expect(secondsLeft(item, 1_000_000)).toBe(10)
    expect(secondsLeft(item, 1_004_500)).toBe(6)
    expect(secondsLeft(item, 1_020_000)).toBe(0)
  })
  it('shows a pending proposal as expired once the time is up, without asking the server', () => {
    expect(effectiveState(item, 1_005_000)).toBe('pending')
    expect(effectiveState(item, 1_010_000)).toBe('expired')
    expect(effectiveState({ ...item, state: 'running' }, 9_999_999)).toBe('running')
  })
  it('formats a countdown', () => {
    expect(clockLabel(247)).toBe('4:07')
    expect(clockLabel(5)).toBe('0:05')
    expect(clockLabel(-3)).toBe('0:00')
  })
})

describe('buttons', () => {
  const at = 1_000_000
  const mk = over => normalizeProposal(raw(over), at)
  it('pending: Deny first and primary, then Run', () => {
    expect(buttonsFor(mk({}), at)).toEqual([
      { kind: 'deny', primary: true, disabled: false },
      { kind: 'run', primary: false, disabled: false }
    ])
  })
  it('disables both while a request is in flight', () => {
    expect(buttonsFor({ ...mk({}), sending: 'run' }, at).every(b => b.disabled)).toBe(true)
  })
  it('offers nothing to run once expired, and only Stop while running', () => {
    expect(buttonsFor(mk({ remaining_s: 1 }), at + 5000)).toEqual([])
    expect(buttonsFor(mk({ state: 'running' }), at).map(b => b.kind)).toEqual(['stop'])
    for (const state of ['finished', 'failed', 'cancelled', 'denied', 'expired']) expect(buttonsFor(mk({ state }), at)).toEqual([])
  })
  it('never offers Run for any state but pending', () => {
    for (const state of ['running', 'finished', 'failed', 'cancelled', 'denied', 'expired']) {
      expect(buttonsFor(mk({ state }), at).some(b => b.kind === 'run')).toBe(false)
    }
  })
})

describe('reducer and counts', () => {
  const at = 1_000_000
  const a = normalizeProposal(raw(), at)
  const b = normalizeProposal(raw({ id: ID2, state: 'running' }), at)
  it('ok replaces the list; empty means empty', () => {
    const s = proposalsReduce(proposalsInitial(), { type: 'proposals.ok', items: [a, b], at })
    expect(s.status).toBe('ready')
    expect(proposalsReduce(s, { type: 'proposals.ok', items: [], at }).status).toBe('empty')
  })
  it('keeps the sending marker of a proposal that is still pending after a refresh', () => {
    let s = proposalsReduce(proposalsInitial(), { type: 'proposals.ok', items: [a], at })
    s = proposalsReduce(s, { type: 'proposal.sending', id: ID, kind: 'run' })
    s = proposalsReduce(s, { type: 'proposals.ok', items: [a], at: at + 1 })
    expect(s.items[0].sending).toBe('run')
  })
  it('a failed list keeps the old items and says unavailable when told so', () => {
    const s = proposalsReduce(proposalsReduce(proposalsInitial(), { type: 'proposals.ok', items: [a], at }), { type: 'proposals.fail', message: '403', unavailable: true })
    expect(s.status).toBe('unavailable')
    expect(s.items.length).toBe(1)
  })
  it('counts only the proposals waiting for a click', () => {
    const s = proposalsReduce(proposalsInitial(), { type: 'proposals.ok', items: [a, b], at })
    expect(waitingCount(s, at)).toBe(1)
    expect(waitingCount(s, at + 400_000)).toBe(0)
  })
})

describe('cardView', () => {
  const at = 1_000_000
  it('gives plain facts and a status line per state', () => {
    const v = cardView(normalizeProposal(raw({ state: 'failed', code: 'active_elsewhere', started: false }), at), at, t)
    expect(v).toMatchObject({ state: 'failed', agent: 'Claude Code', folder: 'C:\\work\\api' })
    expect(v.statusLine).toContain(t('proposal.code.active_elsewhere'))
    expect(cardView(normalizeProposal(raw({ state: 'failed', code: 'timeout', started: true }), at), at, t).statusLine).toBe(
      t('proposal.failedRan', { reason: t('proposal.code.timeout') })
    )
  })
  it('never shows an unknown code raw', () => {
    expect(codeKey('weird_new_code')).toBe('proposal.code.generic')
    expect(codeKey('folder_changed')).toBe('proposal.code.folder_changed')
  })
  it('has a translated sentence for every state and every known code', () => {
    for (const state of ['running', 'finished', 'failed', 'cancelled', 'denied', 'expired']) {
      const line = cardView(normalizeProposal(raw({ state, code: 'timeout' }), at), at, t).statusLine
      expect(line, state).not.toBe('')
      expect(line, state).not.toMatch(/^proposal\./)
    }
  })
})

describe('controller', () => {
  function setup(over = {}) {
    let clock = 1_000_000
    const store = createStore(proposalsReduce, proposalsInitial())
    const rest = vi.fn(async path => {
      if (path === '/proposals') return { ok: true, proposals: [raw()] }
      if (path.endsWith('/run')) return { ok: true, proposal: raw({ state: 'running', started: true }) }
      if (path.endsWith('/cancel')) return { ok: true, proposal: raw({ state: 'denied', code: 'denied' }) }
      throw new Error('unexpected ' + path)
    })
    const ctl = createProposalController({ getState: store.getState, dispatch: store.dispatch, rest: over.rest ?? rest, now: () => clock })
    return { store, rest, ctl, advance: ms => { clock += ms } }
  }
  const loaded = async s => { await s.ctl.refresh(); return s }

  it('lists through ctx.rest and normalises', async () => {
    const s = await loaded(setup())
    expect(s.rest).toHaveBeenCalledWith('/proposals')
    expect(s.store.getState().items.map(i => i.id)).toEqual([ID])
  })

  it('refuses to run without a real click: untrusted, keyboard, wrong type, no event', async () => {
    const s = await loaded(setup())
    for (const bad of [click({ isTrusted: false }), click({ detail: 0 }), click({ type: 'keydown' }), click({ detail: undefined }), null, undefined, {}]) {
      expect(await s.ctl.run(ID, bad)).toEqual({ ok: false, reason: 'not_a_click' })
    }
    expect(s.rest.mock.calls.some(c => String(c[0]).endsWith('/run'))).toBe(false)
  })

  it('runs on a real click and records the new state', async () => {
    const s = await loaded(setup())
    const out = await s.ctl.run(ID, click())
    expect(out).toEqual({ ok: true, state: 'running' })
    expect(s.rest).toHaveBeenCalledWith(`/proposals/${ID}/run`, { method: 'POST' })
    expect(s.store.getState().items[0]).toMatchObject({ state: 'running', sending: '' })
  })

  it('a double click sends once', async () => {
    const s = await loaded(setup())
    const [a, b, c] = await Promise.all([s.ctl.run(ID, click()), s.ctl.run(ID, click({ detail: 2 })), s.ctl.run(ID, click({ detail: 3 }))])
    expect([a.ok, b.reason, c.reason]).toEqual([true, 'busy', 'busy'])
    expect(s.rest.mock.calls.filter(c => String(c[0]).endsWith('/run')).length).toBe(1)
  })

  it('does not run a proposal that is no longer pending or whose time ran out here', async () => {
    const s = await loaded(setup())
    s.advance(400_000)
    expect(await s.ctl.run(ID, click())).toEqual({ ok: false, reason: 'not_pending' })
    const gone = await loaded(setup())
    expect(await gone.ctl.run(ID2, click())).toEqual({ ok: false, reason: 'stale' })
    const done = setup()
    done.rest.mockImplementation(async () => ({ ok: true, proposals: [raw({ state: 'finished' })] }))
    await done.ctl.refresh()
    expect(await done.ctl.run(ID, click())).toEqual({ ok: false, reason: 'not_pending' })
  })

  it('a refused run (the backend said no) is reported and the card follows the backend', async () => {
    const s = setup()
    s.rest.mockImplementation(async path => {
      if (path === '/proposals') return { ok: true, proposals: [raw()] }
      return { ok: false, error: 'active_elsewhere', proposal: raw({ state: 'pending' }) }
    })
    await s.ctl.refresh()
    expect(await s.ctl.run(ID, click())).toEqual({ ok: false, reason: 'refused', code: 'active_elsewhere' })
    expect(s.store.getState().items[0].sending).toBe('')
  })

  it('a failed request clears the sending marker, shows why, and asks the backend what happened', async () => {
    const s = setup()
    let listing = 0
    s.rest.mockImplementation(async path => {
      if (path === '/proposals') {
        listing += 1
        return { ok: true, proposals: [raw({ state: listing > 1 ? 'running' : 'pending' })] }
      }
      throw new Error('socket closed')
    })
    await s.ctl.refresh()
    expect(await s.ctl.run(ID, click())).toEqual({ ok: false, reason: 'failed' })
    await new Promise(r => setTimeout(r, 0))
    expect(listing).toBe(2)
    expect(s.store.getState().items[0].state).toBe('running')
  })

  it('deny works with any trusted gesture, including the keyboard, but not with a script', async () => {
    const s = await loaded(setup())
    expect(await s.ctl.deny(ID, { isTrusted: false, type: 'click', detail: 1 })).toEqual({ ok: false, reason: 'not_a_click' })
    expect(await s.ctl.deny(ID, { isTrusted: true, type: 'keydown', detail: 0 })).toEqual({ ok: true, state: 'denied' })
    expect(s.rest).toHaveBeenCalledWith(`/proposals/${ID}/cancel`, { method: 'POST' })
  })

  it('stop works on a running proposal', async () => {
    const s = setup()
    s.rest.mockImplementation(async path => (path === '/proposals' ? { ok: true, proposals: [raw({ state: 'running' })] } : { ok: true, proposal: raw({ state: 'running' }) }))
    await s.ctl.refresh()
    expect((await s.ctl.deny(ID, click())).ok).toBe(true)
  })

  it('a 403 means unavailable, not a crash', async () => {
    const s = setup({ rest: vi.fn(async () => { throw new Error('Request failed with status 403: native_only') }) })
    expect(await s.ctl.refresh()).toEqual({ ok: false, reason: 'unavailable' })
    expect(s.store.getState().status).toBe('unavailable')
  })

  it('detects the real ctx.rest error shape: "<status>: <json body>"', async () => {
    const s = setup({ rest: vi.fn(async () => { throw new Error('403: {"detail":"native_only"}') }) })
    expect(await s.ctl.refresh()).toEqual({ ok: false, reason: 'unavailable' })
    const other = setup({ rest: vi.fn(async () => { throw new Error('404: {"detail":"Not Found"}') }) })
    expect(await other.ctl.refresh()).toEqual({ ok: false, reason: 'failed' })
    expect(other.store.getState().status).toBe('error')
  })

  it('a malformed list is an error, never an empty list', async () => {
    const s = setup({ rest: vi.fn(async () => ({ nope: 1 })) })
    expect(await s.ctl.refresh()).toEqual({ ok: false, reason: 'bad_reply' })
    expect(s.store.getState().status).toBe('error')
  })

  it('url-encodes the id it puts in a path', async () => {
    const s = setup()
    s.rest.mockImplementation(async () => ({ ok: true, proposals: [raw()] }))
    await s.ctl.refresh()
    await s.ctl.run(ID, click())
    expect(s.rest.mock.calls.at(-1)[0]).toBe(`/proposals/${ID}/run`)
  })
})
