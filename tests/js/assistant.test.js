import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_NAME, PRESETS, createAssistantController, assistantInitial, assistantReduce, sanitizeName } from '../../src/model/assistant.js'
import { createStore } from '../../src/model/store.js'

const { vectors } = JSON.parse(readFileSync(new URL('../shared/name-vectors.json', import.meta.url), 'utf8'))

describe('sanitizeName: the same vectors as the Python side', () => {
  it.each(vectors.map(v => [JSON.stringify(v.input).slice(0, 30), v.input, v.expected]))('%s', (_label, input, expected) => {
    expect(sanitizeName(input)).toBe(expected)
  })
})

describe('presets', () => {
  it('offers Hermes and Jarbas only, no third party trademark', () => {
    expect(DEFAULT_NAME).toBe('Hermes')
    expect(PRESETS).toEqual(['Hermes', 'Jarbas'])
    expect(PRESETS.join(' ').toLowerCase()).not.toContain('jarvis')
  })
})

function setup({ stored = undefined, rest } = {}) {
  const saved = new Map(stored === undefined ? [] : [['assistantName', stored]])
  const storage = { get: (k, d) => (saved.has(k) ? saved.get(k) : d), set: vi.fn((k, v) => saved.set(k, v)) }
  const calls = []
  const restFn = rest ?? (async (path, opts) => { calls.push([path, opts]); return { ok: true, name: opts?.body?.name } })
  const store = createStore(assistantReduce, assistantInitial())
  const ctl = createAssistantController({ getState: store.getState, dispatch: store.dispatch, rest: restFn, storage })
  return { store, ctl, storage, calls, saved }
}

describe('the assistant controller', () => {
  it('starts as Hermes, or as the saved name', () => {
    expect(setup().ctl.load().name).toBe('Hermes')
    const s = setup({ stored: 'Orion' })
    s.ctl.load()
    expect(s.store.getState().name).toBe('Orion')
  })

  it('a saved value is sanitized again when read', () => {
    const s = setup({ stored: '<b>Evil</b>"\nname' })
    s.ctl.load()
    expect(s.store.getState().name).toBe('bEvilb name')
  })

  it('set() sanitizes, stores, updates the state and tells the backend', async () => {
    const s = setup()
    const out = await s.ctl.set('  Friday! ')
    expect(out).toEqual({ ok: true, name: 'Friday' })
    expect(s.store.getState().name).toBe('Friday')
    expect(s.saved.get('assistantName')).toBe('Friday')
    expect(s.calls).toEqual([['/assistant', { method: 'POST', body: { name: 'Friday' } }]])
    expect(s.store.getState().synced).toBe(true)
  })

  it('refuses a blank name and keeps the old one', async () => {
    const s = setup({ stored: 'Orion' })
    s.ctl.load()
    expect(await s.ctl.set('???')).toEqual({ ok: false, reason: 'bad_name' })
    expect(s.store.getState().name).toBe('Orion')
    expect(s.calls).toEqual([])
  })

  it('when the backend cannot be reached the name still applies to the UI and is retried later', async () => {
    let fail = true
    const calls = []
    const s = setup({ rest: async (p, o) => { calls.push(o.body.name); if (fail) throw new Error('403: {"detail":"native_only"}'); return { ok: true } } })
    await s.ctl.set('Orion')
    expect(s.store.getState()).toMatchObject({ name: 'Orion', synced: false })
    fail = false
    await s.ctl.push()
    expect(s.store.getState().synced).toBe(true)
    expect(calls).toEqual(['Orion', 'Orion'])
  })

  it('push() sends the saved name (used on start and on reconnect)', async () => {
    const s = setup({ stored: 'Orion' })
    s.ctl.load()
    await s.ctl.push()
    expect(s.calls[0][1].body).toEqual({ name: 'Orion' })
  })

  it('storage that throws does not break anything', async () => {
    const store = createStore(assistantReduce, assistantInitial())
    const ctl = createAssistantController({
      getState: store.getState, dispatch: store.dispatch, rest: async () => ({ ok: true }),
      storage: { get: () => { throw new Error('no') }, set: () => { throw new Error('no') } }
    })
    expect(ctl.load().name).toBe('Hermes')
    expect((await ctl.set('Orion')).ok).toBe(true)
  })
})
