// Anti-misclick. A card that appears under the pointer, or that jumps while someone is about to click, can turn a click meant
// for something else into an approval. So the buttons that let something happen (Allow, Run, Send) stay disabled for
// ARM_MS after the card first shows, and again for ARM_MS after anything on it changes: its text, its warnings, or its
// size. Deny is never held back.
//
// The gate is plain state plus a timer, so it is tested with fake timers and no DOM.

export const ARM_MS = 700
const LAYOUT_JITTER_PX = 2

/** True when a measured height moved enough to count as the card changing shape. The first measurement is not a change. */
export function layoutChanged(before, after) {
  if (typeof before !== 'number' || typeof after !== 'number') return false
  return Math.abs(after - before) > LAYOUT_JITTER_PX
}

/**
 * @param {{ onChange?: (armed: boolean) => void, ms?: number, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} [opts]
 */
export function createArmGate({ onChange = () => {}, ms = ARM_MS, setTimer = (...a) => setTimeout(...a), clearTimer = id => clearTimeout(id) } = {}) {
  let armed = false
  let signature = null
  let height = null
  let timer = null

  function set(value) {
    if (armed === value) return
    armed = value
    onChange(value)
  }

  function restart() {
    if (timer !== null) clearTimer(timer)
    set(false)
    timer = setTimer(() => {
      timer = null
      set(true)
    }, ms)
  }

  return {
    armed: () => armed,
    /** Tell the gate what the card shows now. The same signature again changes nothing. */
    touch(next) {
      if (next === signature) return
      signature = next
      restart()
    },
    /** Tell the gate how tall the card is now. */
    layout(next) {
      const before = height
      height = next
      if (layoutChanged(before, next)) restart()
    },
    dispose() {
      if (timer !== null) clearTimer(timer)
      timer = null
      signature = null
      height = null
    }
  }
}
