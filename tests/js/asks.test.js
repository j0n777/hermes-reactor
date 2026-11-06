import { describe, expect, it, vi } from 'vitest'

import { asksInitial, asksReduce, buttonsFor, createAskController, extractReply, normalizeAsk, normalizeAskList, pickRoute } from '../../src/model/asks.js'
import { createStore } from '../../src/model/store.js'

const ID = 'AbCdEfGhIjKlMnOpQrStUvWx'
const NOW = 1_700_000_000_000
const click = { isTrusted: true, type: 'click', detail: 1 }
const keyboard = { isTrusted: true, type: 'click', detail: 0 }
const script = { isTrusted: false, type: 'click', detail: 1 }

const raw = (over = {}) => ({ id: ID, label: 'pa-1a2b3c', profile: 'writer', message: 'Write a tagline.', state: 'pending', remaining_s: 290, ...over })

describe('normalizeAsk', () => {
  it('keeps what the card needs, cleaned', () => {
    const a = normalizeAsk(raw(), NOW)
    expect(a).toMatchObject({ id: ID, profile: 'writer', state: 'pending', message: 'Write a tagline.', messageFits: true, remainingS: 290, phase: '', reply: '' })
  })

  it('refuses bad ids, profiles and states', () => {
    expect(normalizeAsk(raw({ id: 'short' }), NOW)).toBeNull()
    expect(normalizeAsk(raw({ id: '../../x'.padEnd(20, 'a') }), NOW)).toBeNull()
    expect(normalizeAsk(raw({ profile: '../x' }), NOW)).toBeNull()
    expect(normalizeAsk(raw({ profile: 'a b' }), NOW)).toBeNull()
    expect(normalizeAsk(raw({ state: 'weird' }), NOW)).toBeNull()
    expect(normalizeAsk(null, NOW)).toBeNull()
  })

  it('a message it cannot show whole turns Send off', () => {
    const long = normalizeAsk(raw({ message: 'x'.repeat(4001) }), NOW)
    expect(long.messageFits).toBe(false)
    expect(buttonsFor(long, NOW).find(b => b.kind === 'send').disabled).toBe(true)
    // The backend cleans before it registers, so hidden characters here mean something is off: show the clean excerpt, Send off.
    const hidden = normalizeAsk(raw({ message: 'a‮b' }), NOW)
    expect(hidden).toMatchObject({ messageFits: false, message: 'ab' })
    expect(hidden.messageHidden).toBeGreaterThan(0)
    expect(buttonsFor(hidden, NOW).find(b => b.kind === 'send').disabled).toBe(true)
  })

  it('list shape', () => {
    expect(normalizeAskList({ ok: true, asks: [raw(), { nope: 1 }] }, NOW)).toHaveLength(1)
    expect(normalizeAskList({ ok: false }, NOW)).toBeNull()
    expect(normalizeAskList(null, NOW)).toBeNull()
  })
})

describe('buttons', () => {
  it('Deny first, then Send; nothing after the ask is used', () => {
    expect(buttonsFor(normalizeAsk(raw(), NOW), NOW).map(b => b.kind)).toEqual(['deny', 'send'])
    expect(buttonsFor(normalizeAsk(raw({ state: 'released' }), NOW), NOW)).toEqual([])
  })

  it('an expired countdown removes Send', () => {
    const a = normalizeAsk(raw({ remaining_s: 3 }), NOW)
    expect(buttonsFor(a, NOW + 10_000)).toEqual([])
  })
})

describe('pickRoute', () => {
  const route = (profile, extra = {}) => ({ connectionId: 'local', mode: 'local', profile, targetProfile: profile, ...extra })
  it('finds the route whose target profile is the one asked', () => {
    expect(pickRoute([route('default'), route('writer')], 'writer')).toEqual(route('writer'))
  })
  it('none, or ambiguous, is null', () => {
    expect(pickRoute([route('default')], 'writer')).toBeNull()
    expect(pickRoute([route('w', { connectionId: 'a', targetProfile: 'writer' }), route('w2', { connectionId: 'b', targetProfile: 'writer' })], 'writer')).toBeNull()
    expect(pickRoute(null, 'writer')).toBeNull()
  })
  it('prefers the primary route when several serve the profile', () => {
    const a = route('w', { connectionId: 'a', targetProfile: 'writer' })
    const b = route('w', { connectionId: 'b', targetProfile: 'writer', primary: true })
    expect(pickRoute([a, b], 'writer')).toEqual(b)
  })
  it('refuses a route with missing fields', () => {
    expect(pickRoute([{ connectionId: '', profile: 'w', targetProfile: 'writer' }], 'writer')).toBeNull()
  })
})

describe('extractReply', () => {
  const hist = messages => ({ count: messages.length, messages })
  it('takes the assistant text after the user message', () => {
    expect(extractReply(hist([{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'Hello there' }]))).toEqual({ text: 'Hello there', final: true })
  })
  it('reads content arrays too', () => {
    const r = extractReply(hist([{ role: 'user', text: 'hi' }, { role: 'assistant', content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] }]))
    expect(r.text).toBe('A\nB')
  })
  it('is not final while a tool is running or nothing came back', () => {
    expect(extractReply(hist([{ role: 'user', text: 'hi' }])).final).toBe(false)
    expect(extractReply(hist([{ role: 'user', text: 'hi' }, { role: 'assistant', text: '' }, { role: 'tool', text: 'out' }])).final).toBe(false)
    expect(extractReply(null)).toEqual({ text: '', final: false })
  })
  it('only counts what came after the LAST user message', () => {
    const r = extractReply(hist([{ role: 'user', text: 'a' }, { role: 'assistant', text: 'old' }, { role: 'user', text: 'b' }, { role: 'assistant', text: 'new' }]))
    expect(r.text).toBe('new')
  })
})

function setup({ routes = [{ connectionId: 'local', mode: 'local', profile: 'writer', targetProfile: 'writer' }], rest, requestProfile, retain = true } = {}) {
  let clock = NOW
  const calls = []
  const store = createStore(asksReduce, asksInitial())
  const released = vi.fn()
  const restFn = rest ?? (async (path, opts) => {
    calls.push(['rest', path, opts?.method ?? 'GET'])
    if (path === '/asks') return { ok: true, asks: [raw()] }
    if (path.endsWith('/release')) return { ok: true, ask: { profile: 'writer', message: 'Write a tagline.' } }
    if (path.endsWith('/deny')) return { ok: true, ask: raw({ state: 'denied', message: '' }) }
    return { ok: false }
  })
  let polls = 0
  const rp = requestProfile ?? (async (route, method, params) => {
    calls.push(['profile', method, JSON.stringify(params)])
    if (method === 'session.create') return { session_id: 'live-1' }
    if (method === 'prompt.submit') return { status: 'streaming' }
    if (method === 'session.history') { polls += 1; return { messages: [{ role: 'user', text: params.session_id && 'Write a tagline.' }, ...(polls >= 1 ? [{ role: 'assistant', text: 'Reactors, assemble.' }] : [])] } }
    return {}
  })
  const ctl = createAskController({
    getState: store.getState,
    dispatch: store.dispatch,
    rest: restFn,
    routes: async () => routes,
    requestProfile: rp,
    retainProfile: retain ? async () => { calls.push(['retain']); return released } : undefined,
    now: () => clock,
    sleep: async ms => { clock += ms },
    timeoutMs: 60_000,
    pollMs: 1000
  })
  return { ctl, store, calls, released, advance: ms => { clock += ms } }
}

describe('the ask controller', () => {
  it('lists asks from the backend', async () => {
    const s = setup()
    expect(await s.ctl.refresh()).toEqual({ ok: true, count: 1 })
    expect(s.store.getState().items).toHaveLength(1)
  })

  it('a real click sends the exact text through the profile route and keeps the reply as untrusted text', async () => {
    const s = setup()
    await s.ctl.refresh()
    const out = await s.ctl.send(ID, click)
    expect(out).toEqual({ ok: true })
    const item = s.store.getState().items[0]
    expect(item).toMatchObject({ phase: 'replied', reply: 'Reactors, assemble.' })
    const kinds = s.calls.map(c => c[0] === 'rest' ? `${c[1]} ${c[2]}` : c[0] === 'profile' ? c[1] : c[0])
    expect(kinds).toEqual(['/asks GET', `/asks/${ID}/release POST`, 'retain', 'session.create', 'prompt.submit', 'session.history', 'session.history'])
    const submit = s.calls.find(c => c[1] === 'prompt.submit')
    expect(JSON.parse(submit[2])).toEqual({ session_id: 'live-1', text: 'Write a tagline.' })
    expect(s.released).toHaveBeenCalledTimes(1)
  })

  it.each([['keyboard', keyboard], ['script', script], ['nothing', null]])('%s activation does nothing', async (_n, ev) => {
    const s = setup()
    await s.ctl.refresh()
    expect(await s.ctl.send(ID, ev)).toEqual({ ok: false, reason: 'not_a_click' })
    expect(s.calls.some(c => c[1]?.includes('release') || c[0] === 'profile')).toBe(false)
  })

  it('a double click sends once', async () => {
    const s = setup()
    await s.ctl.refresh()
    const [a, b] = await Promise.all([s.ctl.send(ID, click), s.ctl.send(ID, click)])
    expect([a.ok, b.ok].sort()).toEqual([false, true])
    expect(s.calls.filter(c => c[1] === 'prompt.submit')).toHaveLength(1)
  })

  it('no route for the profile: nothing is released, so the card can still be used or denied', async () => {
    const s = setup({ routes: [] })
    await s.ctl.refresh()
    expect(await s.ctl.send(ID, click)).toEqual({ ok: false, reason: 'no_route' })
    expect(s.calls.some(c => c[1]?.includes('/release'))).toBe(false)
    expect(s.store.getState().items[0].phase).toBe('')
    expect(s.store.getState().items[0].failure).toBe('no_route')
  })

  it('a refused release (already used, expired) sends nothing', async () => {
    const s = setup({ rest: async path => (path === '/asks' ? { ok: true, asks: [raw()] } : { ok: false, error: 'already_used' }) })
    await s.ctl.refresh()
    expect(await s.ctl.send(ID, click)).toEqual({ ok: false, reason: 'refused', code: 'already_used' })
  })

  it('a transport error is shown on the card and not retried', async () => {
    const s = setup({ requestProfile: async (r, method) => { if (method === 'session.create') throw new Error('4001 gone‮'); return {} } })
    await s.ctl.refresh()
    const out = await s.ctl.send(ID, click)
    expect(out.ok).toBe(false)
    expect(s.store.getState().items[0]).toMatchObject({ phase: 'failed' })
    expect(s.store.getState().items[0].failure).not.toContain('‮')
    expect(s.released).toHaveBeenCalledTimes(1) // the socket is always let go
  })

  it('gives up after the timeout with a clear state, and never injects anything', async () => {
    const s = setup({ requestProfile: async (r, method) => (method === 'session.create' ? { session_id: 'x' } : method === 'session.history' ? { messages: [{ role: 'user', text: 'q' }] } : {}) })
    await s.ctl.refresh()
    const out = await s.ctl.send(ID, click)
    expect(out).toEqual({ ok: false, reason: 'timeout' })
    expect(s.store.getState().items[0].phase).toBe('failed')
  })

  it('works on older hosts without retainProfile', async () => {
    const s = setup({ retain: false })
    await s.ctl.refresh()
    expect((await s.ctl.send(ID, click)).ok).toBe(true)
  })

  it('a reply cannot be longer than the card shows, and hidden characters are removed', async () => {
    const s = setup({ requestProfile: async (r, method, p) => (method === 'session.create' ? { session_id: 'x' } : method === 'session.history' ? { messages: [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a​b' + 'z'.repeat(9000) }] } : {}) })
    await s.ctl.refresh()
    await s.ctl.send(ID, click)
    const reply = s.store.getState().items[0].reply
    expect(reply.startsWith('ab')).toBe(true)
    expect(Array.from(reply).length).toBeLessThanOrEqual(4000)
  })

  it('deny takes any trusted gesture and calls the backend', async () => {
    const s = setup()
    await s.ctl.refresh()
    expect(await s.ctl.deny(ID, script)).toEqual({ ok: false, reason: 'not_a_click' })
    expect((await s.ctl.deny(ID, keyboard)).ok).toBe(true)
    expect(s.store.getState().items[0].state).toBe('denied')
  })

  it('a refresh keeps the local reply even though the backend wiped the text', async () => {
    const s = setup()
    await s.ctl.refresh()
    await s.ctl.send(ID, click)
    // the backend now reports it released with an empty message
    s.store.dispatch({ type: 'asks.ok', items: [normalizeAsk(raw({ state: 'released', message: '' }), NOW)], at: NOW })
    const item = s.store.getState().items[0]
    expect(item.message).toBe('Write a tagline.')
    expect(item.reply).toBe('Reactors, assemble.')
  })

  it('stale: an id nobody knows', async () => {
    const s = setup()
    expect(await s.ctl.send(ID, click)).toEqual({ ok: false, reason: 'stale' })
  })

  it('does not draw an ask that is already over and was never shown in this window', async () => {
    const s = setup({ rest: async path => (path === '/asks' ? { ok: true, asks: [raw({ state: 'released', message: '' }), raw({ id: 'ZyXwVuTsRqPoNmLkJiHgFeDc', state: 'denied', message: '' }), raw({ id: 'QqQqQqQqQqQqQqQqQqQqQqQq' })] } : { ok: false }) })
    await s.ctl.refresh()
    expect(s.store.getState().items.map(i => i.id)).toEqual(['QqQqQqQqQqQqQqQqQqQqQqQq'])
  })

  it('keeps an ask this window did show, after it ended', async () => {
    const s = setup()
    await s.ctl.refresh()
    s.store.dispatch({ type: 'asks.ok', items: [normalizeAsk(raw({ state: 'denied', message: '' }), NOW)], at: NOW })
    expect(s.store.getState().items).toHaveLength(1)
    expect(s.store.getState().items[0].message).toBe('Write a tagline.')
  })
})
