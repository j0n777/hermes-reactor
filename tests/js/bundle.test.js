import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { CSS } from '../../src/styles.js'
import { OUTFILE, bundle, lintBundle } from '../../scripts/bundle.mjs'

const committed = () => readFileSync(OUTFILE, 'utf8').replace(/\r\n/g, '\n')

describe('desktop/plugin.js', () => {
  it('is up to date with src/ (run `npm run build` after changing src/)', async () => {
    expect(committed()).toBe(await bundle())
  })

  it('passes the Desktop surface rules and the import allowlist', () => {
    expect(lintBundle(committed())).toEqual([])
  })

  it('imports only the SDK, react and react/jsx-runtime', () => {
    const specs = [...committed().matchAll(/from\s*"([^"]+)"/g)].map(m => m[1])
    expect(new Set(specs)).toEqual(new Set(['@hermes/plugin-sdk', 'react', 'react/jsx-runtime']))
  })

  it('is unminified, readable ESM with a default export', () => {
    const text = committed()
    expect(text.split('\n').length).toBeGreaterThan(1000)
    expect(text).toMatch(/export\s*\{[^}]*as default/)
  })

  it('contains no network or storage-escape calls', () => {
    const text = committed()
    expect(text).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|navigator\.sendBeacon|localStorage|indexedDB|document\.cookie/)
  })

  it('contains no film trademark names', () => {
    expect(committed().toLowerCase()).not.toMatch(/jarvis|stark|iron man/)
  })

  it('has no non-ASCII bytes (the file loads as plain ESM anywhere)', () => {
    expect(/[^\x00-\x7F]/.test(committed())).toBe(false)
  })
})

describe('injected CSS', () => {
  it('uses Hermes theme tokens, with hardcoded colours only from the closed control-room list', () => {
    expect(CSS).toContain('var(--ui-accent')
    expect(CSS).toContain('var(--ui-red')
    // Explicit colours exist on purpose: the reactor palette (cyan, amber, red on navy), the always-dark stage page,
    // and the button/badge text that must hold 4.5:1 on any theme (tests/js/review-fixes.test.js checks the ratios).
    const allowed = new Set([
      '#22d3ee', '#67e8f9', '#a78bfa', '#38bdf8', '#2dd4bf', '#fbbf24', '#f87171', '#64748b', '#060d1f', '#08142e',
      '#e8f1ff', '#b9cbe8', '#93a8cc', '#7f95bb', '#2c4170', '#1f3059', '#0b1630', '#34d399', '#fb923c',
      '#1e40af', '#1d4ed8', '#93c5fd', '#ffffff', '#04101f'
    ])
    const found = [...CSS.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(m => m[0].toLowerCase())
    expect(found.filter(c => !allowed.has(c))).toEqual([])
    expect(CSS.match(/\brgba?\(/g) ?? []).toHaveLength(1)
    expect(CSS).not.toMatch(/\bhsla?\(/)
  })
  it('switches every animation off under prefers-reduced-motion', () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)[^}]*\{[^}]*animation: none !important/)
  })
  it('has a distinct still shape for each state under reduced motion', () => {
    const block = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'))
    for (const state of ['listening', 'responding', 'thinking', 'approval', 'error']) {
      expect(block).toContain(`data-state='${state}'`)
    }
  })
  it('never selects Hermes own markup', () => {
    expect(CSS).not.toMatch(/\[data-(slot|tour|sidebar|testid|tree-|pane-host|titlebar-cluster)/)
  })
  it('colours the error state red from the theme', () => {
    expect(CSS).toMatch(/\.jh-reactor\[data-state='error'\]\s*\{\s*--jh-c:\s*var\(--ui-red/)
  })
})
