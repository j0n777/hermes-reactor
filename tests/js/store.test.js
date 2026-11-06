import { describe, expect, it, vi } from 'vitest'
import { createStore } from '../../src/model/store.js'

describe('createStore', () => {
  const reducer = (s, a) => (a.type === 'inc' ? { n: s.n + 1 } : s)
  it('notifies on change only', () => {
    const store = createStore(reducer, { n: 0 })
    const listener = vi.fn()
    store.subscribe(listener)
    store.dispatch({ type: 'noop' })
    expect(listener).not.toHaveBeenCalled()
    store.dispatch({ type: 'inc' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getState().n).toBe(1)
  })
  it('unsubscribes and survives a throwing listener', () => {
    const store = createStore(reducer, { n: 0 })
    const good = vi.fn()
    store.subscribe(() => { throw new Error('boom') })
    const off = store.subscribe(good)
    store.dispatch({ type: 'inc' })
    expect(good).toHaveBeenCalledTimes(1)
    off()
    store.dispatch({ type: 'inc' })
    expect(good).toHaveBeenCalledTimes(1)
  })
})
