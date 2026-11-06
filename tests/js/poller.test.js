import { describe, expect, it, vi } from 'vitest'
import { MAX_BACKOFF_MS, MIN_INTERVAL_MS, createPoller } from '../../src/model/poller.js'

function fakeTimers() {
  const timers = []
  return {
    timers,
    setTimer: (fn, ms) => {
      const entry = { fn, ms, cancelled: false }
      timers.push(entry)
      return () => { entry.cancelled = true }
    },
    pending: () => timers.filter(t => !t.cancelled),
    async fireNext() {
      const next = this.pending()[0]
      if (!next) return false
      next.cancelled = true
      await next.fn()
      return true
    }
  }
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('createPoller', () => {
  it('runs immediately on start and then schedules the next run', async () => {
    const clock = fakeTimers()
    const run = vi.fn(async () => true)
    const poller = createPoller({ run, intervalMs: 20_000, setTimer: clock.setTimer })
    poller.start()
    await flush()
    expect(run).toHaveBeenCalledTimes(1)
    expect(clock.pending().map(t => t.ms)).toEqual([20_000])
    await clock.fireNext()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('never polls faster than the minimum interval', async () => {
    const clock = fakeTimers()
    const poller = createPoller({ run: async () => true, intervalMs: 100, setTimer: clock.setTimer })
    poller.start()
    await flush()
    expect(clock.pending()[0].ms).toBe(MIN_INTERVAL_MS)
  })

  it('backs off after failures and resets after a success', async () => {
    const clock = fakeTimers()
    const results = [false, false, true]
    const poller = createPoller({ run: async () => results.shift(), intervalMs: 10_000, setTimer: clock.setTimer })
    poller.start()
    await flush()
    expect(clock.pending()[0].ms).toBe(20_000)
    await clock.fireNext()
    expect(clock.pending()[0].ms).toBe(40_000)
    await clock.fireNext()
    expect(clock.pending()[0].ms).toBe(10_000)
  })

  it('caps the backoff', async () => {
    const clock = fakeTimers()
    const poller = createPoller({ run: async () => { throw new Error('x') }, intervalMs: 10_000, setTimer: clock.setTimer })
    poller.start()
    await flush()
    for (let i = 0; i < 10; i += 1) await clock.fireNext()
    expect(clock.pending()[0].ms).toBeLessThanOrEqual(MAX_BACKOFF_MS)
  })

  it('skips runs while canRun is false but keeps the schedule', async () => {
    const clock = fakeTimers()
    let allowed = false
    const run = vi.fn(async () => true)
    const onSkip = vi.fn()
    const poller = createPoller({ run, intervalMs: 10_000, canRun: () => allowed, setTimer: clock.setTimer, onSkip })
    poller.start()
    await flush()
    expect(run).not.toHaveBeenCalled()
    expect(onSkip).toHaveBeenCalledTimes(1)
    allowed = true
    await clock.fireNext()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('never overlaps runs', async () => {
    const clock = fakeTimers()
    let release
    const run = vi.fn(() => new Promise(resolve => { release = () => resolve(true) }))
    const poller = createPoller({ run, intervalMs: 10_000, setTimer: clock.setTimer })
    poller.start()
    await flush()
    await poller.refresh()
    expect(run).toHaveBeenCalledTimes(1)
    release()
    await flush()
  })

  it('stop cancels the timer and prevents further runs', async () => {
    const clock = fakeTimers()
    const run = vi.fn(async () => true)
    const poller = createPoller({ run, intervalMs: 10_000, setTimer: clock.setTimer })
    poller.start()
    await flush()
    poller.stop()
    expect(clock.pending().length).toBe(0)
    expect(poller.isActive()).toBe(false)
    await clock.fireNext()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('a manual refresh runs once and does not start a loop', async () => {
    const clock = fakeTimers()
    const run = vi.fn(async () => true)
    const poller = createPoller({ run, intervalMs: 10_000, setTimer: clock.setTimer })
    await poller.refresh()
    expect(run).toHaveBeenCalledTimes(1)
    expect(poller.isActive()).toBe(false)
    expect(clock.pending().length).toBe(0)
  })
})
