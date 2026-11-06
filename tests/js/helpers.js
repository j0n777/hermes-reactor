// Shared test helpers: a runtime wired to fakes, no Hermes, no DOM.
import { vi } from 'vitest'

import { createRuntime } from '../../src/runtime.js'
import { setRuntime } from '../../src/views/hooks.js'

export const atom = value => ({ get: () => value, subscribe: fn => { fn(value); return () => {} } })

export function fakeRuntime(overrides = {}) {
  const request = vi.fn(async () => ({}))
  const notify = vi.fn()
  const composer = { insertText: vi.fn(async () => true), focus: vi.fn() }
  const prefs = new Map([['locale', 'en']])
  const rt = createRuntime({
    request,
    onEvent: vi.fn(() => () => {}),
    setTimeout: () => () => {},
    setInterval: () => () => {},
    storage: { get: (k, d) => (prefs.has(k) ? prefs.get(k) : d), set: (k, v) => prefs.set(k, v) },
    hostState: { gateway: atom('open'), busy: atom(false), awaitingResponse: atom(false), focusedSessionId: atom('s1'), activeSessionId: atom('s1') },
    notify,
    composer,
    navigate: vi.fn(),
    now: () => 1_700_000_000_000,
    ...overrides
  })
  setRuntime(rt)
  rt.store.dispatch({ type: 'host', patch: { gateway: 'open', focusedSessionId: 's1' } })
  return { rt, request, notify, composer, prefs }
}
