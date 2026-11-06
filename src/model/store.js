// A tiny external store. The React views subscribe with useSyncExternalStore; the
// event handlers dispatch. No React import here, so it is testable and shared.

export function createStore(reducer, initial) {
  let state = initial
  const listeners = new Set()
  return {
    getState: () => state,
    dispatch(action) {
      const next = reducer(state, action)
      if (next === state) return
      state = next
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch {
          // A broken subscriber must not stop the others.
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
