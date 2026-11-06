import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { matchRef, normalizeList } from '../../src/model/agents.js'

// The same vectors tests/py/test_ref_contract.py checks against the plugin's Python `_make_ref`
// and Hermes' own hashing: id = sha256(`${agent}:${path}`), ref = its first 12 hex digits.
const { vectors } = JSON.parse(readFileSync(new URL('../shared/ref-vectors.json', import.meta.url), 'utf8'))

describe('::reactor-session ref contract', () => {
  const rows = normalizeList({
    sessions: vectors.map((v, i) => ({ id: v.id, source: v.agent, title: `t${i}`, cwd: '/x', mtime: 1000 + i, turn_count: 1 })),
    next_offset: null
  }).rows

  it('has vectors', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(3)
  })

  it.each(vectors.map(v => [v.agent, v.ref, v.id]))('a %s card with ref %s finds its Desktop row', (_agent, ref, id) => {
    const row = matchRef(ref, rows)
    expect(row).not.toBeNull()
    expect(row.id).toBe(id)
  })

  it('refuses a ref made the old way (agent NUL session id)', () => {
    expect(matchRef('0123456789ab', rows)).toBeNull()
  })
})
