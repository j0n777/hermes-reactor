// A polite poller. One run at a time, never faster than `intervalMs`, slower after
// failures, paused when told it cannot run. Timers are injected (the plugin passes
// ctx.setTimeout, which is cleaned up when the plugin unloads).

export const MIN_INTERVAL_MS = 4_000
export const MAX_BACKOFF_MS = 60_000

/**
 * @param {{
 *   run: () => Promise<boolean | void>,
 *   intervalMs: number,
 *   canRun?: () => boolean,
 *   setTimer: (fn: () => void, ms: number) => (() => void),
 *   onSkip?: () => void
 * }} options  `run` returns false (or throws) to signal a failure and trigger backoff.
 */
export function createPoller({ run, intervalMs, canRun = () => true, setTimer, onSkip }) {
  const base = Math.max(MIN_INTERVAL_MS, intervalMs)
  let cancelTimer = null
  let running = false
  let active = false
  let failures = 0

  function delay() {
    return failures === 0 ? base : Math.min(MAX_BACKOFF_MS, base * 2 ** Math.min(failures, 5))
  }

  function schedule(ms = delay()) {
    if (!active) return
    if (cancelTimer) cancelTimer()
    cancelTimer = setTimer(tick, ms)
  }

  async function tick() {
    cancelTimer = null
    if (!active) return
    if (running) return schedule()
    if (!canRun()) {
      if (onSkip) onSkip()
      return schedule()
    }
    running = true
    try {
      const ok = await run()
      failures = ok === false ? failures + 1 : 0
    } catch {
      failures += 1
    } finally {
      running = false
    }
    schedule()
  }

  return {
    /** Start polling. Runs once right away. */
    start() {
      if (active) return
      active = true
      failures = 0
      void tick()
    },
    stop() {
      active = false
      if (cancelTimer) cancelTimer()
      cancelTimer = null
    },
    /** Run now (a manual refresh), unless a run is already in flight. */
    async refresh() {
      if (running) return
      if (cancelTimer) cancelTimer()
      cancelTimer = null
      const wasActive = active
      active = true
      await tick()
      if (!wasActive) {
        // Keep manual-only refreshes from starting a loop.
        active = false
        if (cancelTimer) cancelTimer()
        cancelTimer = null
      }
    },
    isActive: () => active,
    isRunning: () => running
  }
}
