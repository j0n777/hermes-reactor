import { describe, expect, it } from 'vitest'
import {
  buttonsFor,
  cardKey,
  explain,
  isApproving,
  isChoiceAllowed,
  isRealClick,
  isTrustedGesture,
  makeCard,
  shouldTakeFocus
} from '../../src/model/approval.js'
import { makeT } from '../../src/model/i18n.js'

const base = { sessionId: 's1', requestId: 'r1' }
const all = ['once', 'session', 'always', 'deny']
const choicesOf = card => buttonsFor(card).map(b => b.choice)

describe('makeCard', () => {
  it('requires ids', () => {
    expect(makeCard({ requestId: 'r' })).toBeNull()
    expect(makeCard({ sessionId: 's' })).toBeNull()
    expect(makeCard({ sessionId: '', requestId: 'r' })).toBeNull()
    expect(makeCard(null)).toBeNull()
  })
  it('builds a key from session and request', () => {
    expect(makeCard(base).key).toBe(cardKey('s1', 'r1'))
  })
  it('sanitises command, description and tool', () => {
    const c = makeCard({ ...base, command: 'ls‮ -la\u0000', description: 'a​b', toolName: 'sh\nell' })
    expect(c.command).toBe('ls -la')
    expect(c.description).toBe('ab')
    expect(c.toolName).toBe('sh ell')
  })
  it('adds deny when the backend forgot it, and drops unknown choices', () => {
    const c = makeCard({ ...base, command: 'ls', choices: ['once', 'launch-missiles'] })
    expect(c.choices).toEqual(['once', 'deny'])
  })
  it('defaults to once and deny when no choices are given', () => {
    expect(makeCard(base).choices).toEqual(['once', 'deny'])
  })
  it('a command with hidden characters is never read-only', () => {
    const c = makeCard({ ...base, command: 'ls‮', choices: all })
    expect(c.level).toBe('unknown')
  })
  it('keeps a destructive classification even with hidden characters', () => {
    const c = makeCard({ ...base, command: 'rm​ -rf /', choices: all })
    expect(c.level).toBe('destructive')
  })
})

describe('button set', () => {
  it('deny is always first, always present, and the primary action', () => {
    for (const command of ['ls', 'rm -rf /', 'whatever', '']) {
      const buttons = buttonsFor(makeCard({ ...base, command, choices: all }))
      expect(buttons[0]).toEqual({ choice: 'deny', approving: false, primary: true })
      expect(buttons.filter(b => b.primary).length).toBe(1)
    }
  })
  it('never offers "always" for a destructive command', () => {
    expect(choicesOf(makeCard({ ...base, command: 'rm -rf node_modules', choices: all }))).not.toContain('always')
  })
  it('never offers "always" or "session" for a destructive command', () => {
    expect(choicesOf(makeCard({ ...base, command: 'git push --force', choices: all }))).toEqual(['deny', 'once'])
  })
  it('never offers "always" for an unknown command', () => {
    expect(choicesOf(makeCard({ ...base, command: 'npm install left-pad', choices: all }))).toEqual(['deny', 'once', 'session'])
  })
  it('never offers "always" for an empty or unparsable command', () => {
    expect(choicesOf(makeCard({ ...base, command: '', choices: all }))).not.toContain('always')
    expect(choicesOf(makeCard({ ...base, command: 'echo "x', choices: all }))).not.toContain('always')
  })
  it('offers "always" only for a read-only command that the backend offers it for', () => {
    expect(choicesOf(makeCard({ ...base, command: 'git status', choices: all }))).toEqual(['deny', 'once', 'session', 'always'])
    expect(choicesOf(makeCard({ ...base, command: 'git status', choices: ['once', 'deny'] }))).toEqual(['deny', 'once'])
  })
  it('does not invent choices the backend did not offer', () => {
    expect(choicesOf(makeCard({ ...base, command: 'ls', choices: ['deny'] }))).toEqual(['deny'])
  })
  it('isChoiceAllowed matches the button set', () => {
    const c = makeCard({ ...base, command: 'rm x', choices: all })
    expect(isChoiceAllowed(c, 'once')).toBe(true)
    expect(isChoiceAllowed(c, 'always')).toBe(false)
    expect(isChoiceAllowed(c, 'bogus')).toBe(false)
  })
  it('isApproving', () => {
    expect(isApproving('deny')).toBe(false)
    for (const c of ['once', 'session', 'always']) expect(isApproving(c)).toBe(true)
  })
})

describe('what counts as a real click', () => {
  it('needs a trusted click event with detail > 0', () => {
    expect(isRealClick({ type: 'click', isTrusted: true, detail: 1 })).toBe(true)
    expect(isRealClick({ type: 'click', isTrusted: true, detail: 2 })).toBe(true)
  })
  it('rejects keyboard activation (detail 0)', () => {
    expect(isRealClick({ type: 'click', isTrusted: true, detail: 0 })).toBe(false)
  })
  it('rejects script-made events (not trusted)', () => {
    expect(isRealClick({ type: 'click', isTrusted: false, detail: 1 })).toBe(false)
    expect(isRealClick({ type: 'click', detail: 1 })).toBe(false)
  })
  it('rejects other event types and bad input', () => {
    expect(isRealClick({ type: 'keydown', isTrusted: true, detail: 1 })).toBe(false)
    expect(isRealClick({ type: 'click', isTrusted: true, detail: '1' })).toBe(false)
    expect(isRealClick(null)).toBe(false)
    expect(isRealClick(undefined)).toBe(false)
  })
  it('Escape is never a click', () => {
    expect(isRealClick({ type: 'keydown', key: 'Escape', isTrusted: true, detail: 0 })).toBe(false)
  })
  it('deny accepts any trusted gesture', () => {
    expect(isTrustedGesture({ isTrusted: true, detail: 0 })).toBe(true)
    expect(isTrustedGesture({ isTrusted: false, detail: 1 })).toBe(false)
    expect(isTrustedGesture(null)).toBe(false)
  })
})

describe('focus rule', () => {
  it('takes focus only when nothing is focused or focus is already inside our UI', () => {
    expect(shouldTakeFocus({ activeIsBody: true, activeInsideRoot: false })).toBe(true)
    expect(shouldTakeFocus({ activeIsBody: false, activeInsideRoot: true })).toBe(true)
    expect(shouldTakeFocus({ activeIsBody: false, activeInsideRoot: false })).toBe(false)
  })
})

describe('explain', () => {
  const t = makeT('en')
  it('describes a safe command without scaring', () => {
    const e = explain(makeCard({ ...base, command: 'git status', description: 'status', choices: all }), t)
    expect(e.riskLabel).toBe('Looks read-only')
    expect(e.what).toBe('git status')
    expect(e.why).toBe('status')
  })
  it('lists what a destructive command may do', () => {
    const e = explain(makeCard({ ...base, command: 'rm -rf build && git push --force', choices: all }), t)
    expect(e.riskLabel).toBe('Risky')
    expect(e.may.join(' ')).toContain('delete files')
    expect(e.may.join(' ')).toContain('git history')
  })
  it('treats unknown as risky in words', () => {
    const e = explain(makeCard({ ...base, command: 'make deploy', choices: all }), t)
    expect(e.riskLabel).toBe('Unverified')
    expect(e.may[0]).toContain('treated as risky')
  })
  it('has fallbacks for missing command and reason', () => {
    const e = explain(makeCard({ ...base }), t)
    expect(e.what).toBe('(no command text provided)')
    expect(e.why).toBe('Hermes flagged this action for review.')
  })
  it('works in Portuguese', () => {
    const e = explain(makeCard({ ...base, command: 'rm x', choices: all }), makeT('pt-BR'))
    expect(e.riskLabel).toBe('Arriscado')
  })
})
