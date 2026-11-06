// Fixes from the security review. Each test here failed before its fix. Ported from the review proofs
// (review.test.mjs) and extended: the card shows the instruction it will send, clipped approval commands must be
// opened before they are allowed, the two risk classifiers and the two sanitizers share their vectors with Python.
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { buttonsFor as approvalButtons, makeCard, approveBlock } from '../../src/model/approval.js'
import { createApprovalController } from '../../src/model/approval-controller.js'
import { makeT } from '../../src/model/i18n.js'
import { buttonsFor, cardView, createProposalController, INSTRUCTION_MAX_CHARS, INSTRUCTION_MAX_LINES, instructionCheck, normalizeProposal, proposalsInitial, proposalsReduce } from '../../src/model/proposals.js'
import { classifyCommand } from '../../src/model/risk.js'
import { cleanText, ELLIPSIS } from '../../src/model/sanitize.js'
import { initialState, reduce } from '../../src/model/state.js'
import { createStore } from '../../src/model/store.js'
import { ApprovalCard } from '../../src/views/ApprovalCard.js'
import { ProposalCard } from '../../src/views/ProposalCard.js'
import { h } from '../../src/views/h.js'
import { fakeRuntime } from './helpers.js'

const shared = name => JSON.parse(readFileSync(new URL(`../shared/${name}`, import.meta.url), 'utf8'))
const NOW = 1_700_000_000_000
const ID = 'A'.repeat(32)
const t = makeT('en')
const tPt = makeT('pt-BR')
const click = { type: 'click', isTrusted: true, detail: 1 }
const render = element => renderToStaticMarkup(element)
const buttonLabels = html => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(m => m[1])
const unescapeHtml = s => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const raw = (over = {}) => ({ id: ID, agent: 'claude', title: 'Fix', folder: 'C:\\work', instruction: 'go', state: 'pending', remaining_s: 240, ...over })
const instructionOf = html => unescapeHtml(html.match(/<pre class="jh-code jh-pr-instruction"[^>]*>([\s\S]*?)<\/pre>/)[1])

// --- 1. the card shows exactly what is sent ------------------------------------------------------------------------------

describe('instruction: rendered text equals sent text', () => {
  const limits = { chars: INSTRUCTION_MAX_CHARS, lines: INSTRUCTION_MAX_LINES }

  it('uses the limits the backend enforces', () => {
    expect(limits).toEqual({ chars: 4000, lines: 40 })
  })

  it.each([
    ['one line', 'run the tests'],
    ['trailing spaces and blank lines', 'first  \n\n  indented\twith tab\nlast'],
    ['exactly 40 lines', Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')],
    ['exactly 4000 characters', 'x'.repeat(4000)],
    ['markup stays text', '<img src=x onerror=alert(1)> & "quotes" \'single\'']
  ])('%s is drawn character for character and Run is on', (_name, instruction) => {
    fakeRuntime()
    const item = normalizeProposal(raw({ instruction }), NOW)
    expect(item.instructionFits).toBe(true)
    expect(item.instruction).toBe(instruction)
    expect(instructionOf(render(h(ProposalCard, { item, t, now: NOW })))).toBe(instruction)
    expect(buttonsFor(item, NOW).find(b => b.kind === 'run').disabled).toBe(false)
  })

  it.each([
    ['the review case, 200 lines', Array.from({ length: 200 }, (_, i) => 'l' + i).join('\n')],
    ['41 lines', Array.from({ length: 41 }, (_, i) => `line ${i}`).join('\n')],
    ['4001 characters', 'x'.repeat(4001)],
    ['a hidden character inside', 'run the tests\u200b and rm'],
    ['a Hangul filler inside', 'run\u3164the tests']
  ])('%s is never drawn as if whole: Run is off and the card says what is not shown', (_name, instruction) => {
    fakeRuntime()
    const item = normalizeProposal(raw({ instruction }), NOW)
    expect(item.instructionFits).toBe(false)
    expect(item.instructionHidden).toBeGreaterThan(0)
    const run = buttonsFor(item, NOW).find(b => b.kind === 'run')
    expect(run.disabled).toBe(true)
    const html = render(h(ProposalCard, { item, t, now: NOW }))
    expect(html).toContain('Run is off')
    expect(html).toContain(`${item.instructionHidden} characters are not shown`)
    expect(html).toContain('disabled')
    expect(buttonLabels(html)).toEqual(['Deny', 'Run'])
  })

  it('never shows the hidden characters themselves', () => {
    const item = normalizeProposal(raw({ instruction: 'a\u202eb\u3164c' }), NOW)
    expect(item.instruction).toBe('abc')
    expect(item.instructionFits).toBe(false)
  })

  it('the controller refuses Run for an instruction that is not shown whole, and sends nothing', async () => {
    const state = { current: proposalsReduce(proposalsInitial(), { type: 'proposals.ok', items: [normalizeProposal(raw({ instruction: 'x'.repeat(5000) }), NOW)], at: NOW }) }
    const rest = vi.fn()
    const controller = createProposalController({ getState: () => state.current, dispatch: a => { state.current = proposalsReduce(state.current, a) }, rest, now: () => NOW })
    expect(await controller.run(ID, click)).toEqual({ ok: false, reason: 'instruction_hidden' })
    expect(rest).not.toHaveBeenCalled()
  })

  it('Deny stays on for a card that cannot show its instruction', () => {
    const item = normalizeProposal(raw({ instruction: 'x'.repeat(5000) }), NOW)
    expect(buttonsFor(item, NOW).find(b => b.kind === 'deny').disabled).toBe(false)
  })

  it('instructionCheck gives a short excerpt of an over-long text, never the whole of it', () => {
    const out = instructionCheck('y\n'.repeat(500))
    expect(out.fits).toBe(false)
    expect(out.shown.split('\n').length).toBeLessThanOrEqual(INSTRUCTION_MAX_LINES)
  })

  it('knows the backend refusal code', () => {
    const item = normalizeProposal(raw({ state: 'failed', code: 'instruction_too_long' }), NOW)
    expect(cardView(item, NOW, t).statusLine).toContain('too long')
    expect(cardView(item, NOW, tPt).statusLine).toContain('longa demais')
  })
})

// --- 2. clipped approval commands ----------------------------------------------------------------------------------------

describe('approval: a clipped command must be opened before it is allowed', () => {
  const longCommand = 'echo ' + 'a'.repeat(2000) + ' && true'
  const manyLines = Array.from({ length: 30 }, (_, i) => `echo line${i}`).join('\n')

  function setup(command) {
    const store = createStore(reduce, initialState())
    store.dispatch({ type: 'host', patch: { gateway: 'open' } })
    store.dispatch({ type: 'approval.request', sessionId: 's1', requestId: 'r1', command, description: 'why', choices: ['once', 'session', 'always', 'deny'], at: 1 })
    const request = vi.fn(async () => ({ resolved: 1 }))
    const controller = createApprovalController({ getState: store.getState, dispatch: store.dispatch, request, now: () => 5 })
    return { store, controller, request, key: store.getState().approvals[0].key }
  }

  it('a short command is not clipped and needs nothing', () => {
    const card = makeCard({ sessionId: 's', requestId: 'r', command: 'npm test' }, 0)
    expect(card.clipped).toBe(false)
    expect(card.hiddenChars).toBe(0)
    expect(approveBlock(card)).toBe('')
  })

  it.each([['900 characters', longCommand], ['14 lines', manyLines]])('a command over the %s preview is clipped and says how much is hidden', (_n, command) => {
    const card = makeCard({ sessionId: 's', requestId: 'r', command }, 0)
    expect(card.clipped).toBe(true)
    expect(card.hiddenChars).toBeGreaterThan(0)
    expect(card.commandFull).toBe(command)
    expect(approveBlock(card)).toBe('must_expand')
    expect(Array.from((card.command.endsWith(ELLIPSIS) ? card.command.slice(0, -1) : card.command)).length + card.hiddenChars).toBe(Array.from(command).length)
  })

  it('the card shows the banner and keeps every approve button off, Deny on', () => {
    const { rt } = fakeRuntime()
    rt.store.dispatch({ type: 'approval.request', sessionId: 's1', requestId: 'r1', command: longCommand, description: 'why', choices: ['once', 'deny'], at: NOW })
    const card = rt.store.getState().approvals[0]
    const html = render(h(ApprovalCard, { card, t }))
    expect(html).toContain(`${card.hiddenChars} characters are hidden`)
    expect(html).toContain('Show the whole command')
    expect(html).toContain('Allow is off until you open the whole command')
    const buttons = [...html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].map(m => ({ label: m[2], disabled: /disabled/.test(m[1]) }))
    expect(buttons.find(b => b.label === 'Deny').disabled).toBe(false)
    expect(buttons.find(b => b.label === 'Allow once').disabled).toBe(true)
  })

  it('the controller refuses to approve a clipped command that was not opened, but denies', async () => {
    const { controller, request, key } = setup(longCommand)
    expect(await controller.answer(key, 'once', click)).toEqual({ ok: false, reason: 'must_expand' })
    expect(await controller.answer(key, 'session', click)).toEqual({ ok: false, reason: 'must_expand' })
    expect(request).not.toHaveBeenCalled()
    expect((await controller.answer(key, 'deny', click)).ok).toBe(true)
    expect(request).toHaveBeenCalledWith('approval.respond', expect.objectContaining({ choice: 'deny' }), undefined)
  })

  it('opening needs a trusted gesture; then the whole text is shown and approving works', async () => {
    const { store, controller, request, key } = setup(longCommand)
    expect(controller.expand(key, { type: 'click', isTrusted: false, detail: 1 })).toEqual({ ok: false, reason: 'not_a_click' })
    expect(store.getState().approvals[0].expanded).toBe(false)
    expect(controller.expand(key, click)).toEqual({ ok: true })
    const card = store.getState().approvals[0]
    expect(card.expanded).toBe(true)
    expect(approveBlock(card)).toBe('')
    const html = render(h(ApprovalCard, { card: { ...card }, t }))
    expect(unescapeHtml(html)).toContain(longCommand)
    expect(html).toContain('jh-code-full')
    expect(html).not.toContain('characters are hidden')
    expect((await controller.answer(key, 'once', click)).ok).toBe(true)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('a changed command under the same request forgets that it was opened', () => {
    const { store, controller, key } = setup(longCommand)
    controller.expand(key, click)
    store.dispatch({ type: 'approval.request', sessionId: 's1', requestId: 'r1', command: longCommand + ' --other', description: 'why', at: 2 })
    expect(store.getState().approvals[0].expanded).toBe(false)
    store.dispatch({ type: 'approval.request', sessionId: 's1', requestId: 'r1', command: longCommand + ' --other', description: 'why', at: 3 })
    controller.expand(key, click)
    store.dispatch({ type: 'approval.request', sessionId: 's1', requestId: 'r1', command: longCommand + ' --other', description: 'why', at: 4 })
    expect(store.getState().approvals[0].expanded).toBe(true)
  })

  it('a command too long even for the full view can only be denied', async () => {
    const { store, controller, key } = setup('x'.repeat(30000))
    const card = store.getState().approvals[0]
    expect(card.unviewable).toBe(true)
    expect(approveBlock(card)).toBe('too_long')
    expect(await controller.answer(key, 'once', click)).toEqual({ ok: false, reason: 'too_long' })
    expect(approvalButtons(card).find(b => b.choice === 'deny')).toBeTruthy()
    expect((await controller.answer(key, 'deny', click)).ok).toBe(true)
  })
})

// --- 3 and 4. the shared command list -----------------------------------------------------------------------------------

describe('risk: one list for both classifiers', () => {
  const { cases } = shared('risk-vectors.json')
  it.each(cases.map(c => [c.cmd, c.safe]))('%s -> safe=%s', (cmd, safe) => {
    const level = classifyCommand(cmd).level
    expect(level === 'safe').toBe(safe)
  })

  it.each(['git branch -vd main', 'git branch --del main', 'git branch --delete main', 'git tag --del v1', 'git branch -D x', 'git push --forc origin main'])('%s is called destructive, also when abbreviated', cmd => {
    expect(classifyCommand(cmd).level).toBe('destructive')
  })

  it.each(['git branch -vd main', 'git branch --del main', 'git branch newbranch', 'tree -o out.txt', 'file -C'])('review case: %s is not safe', cmd => {
    expect(classifyCommand(cmd).level).not.toBe('safe')
  })
})

// --- 6. disclosure on the Run card ---------------------------------------------------------------------------------------

describe('Run card: claude -p skips the trust dialog', () => {
  it('says so in English and Portuguese for a Claude session', () => {
    fakeRuntime()
    const item = normalizeProposal(raw(), NOW)
    expect(render(h(ProposalCard, { item, t, now: NOW }))).toContain('skips its trust dialog')
    expect(render(h(ProposalCard, { item, t: tPt, now: NOW }))).toContain('pula o diálogo de confiança')
  })

  it('warns by file name when the folder has project hooks', () => {
    fakeRuntime()
    const item = normalizeProposal(raw({ project_hooks: ['settings.json', '<b>x</b>.json'] }), NOW)
    const html = render(h(ProposalCard, { item, t, now: NOW }))
    expect(html).toContain('This folder defines project hooks')
    expect(html).toContain('settings.json')
    expect(html).not.toContain('<b>')
    expect(render(h(ProposalCard, { item: normalizeProposal(raw(), NOW), t, now: NOW }))).not.toContain('project hooks')
    expect(render(h(ProposalCard, { item, t: tPt, now: NOW }))).toContain('hooks de projeto')
  })
})

// --- 8. sanitizer ---------------------------------------------------------------------------------------------------------

describe('sanitizer: the same vectors as Python', () => {
  const vectors = shared('sanitize-vectors.json')
  const ch = cp => String.fromCodePoint(parseInt(cp, 16))
  it.each(vectors.hidden.map(v => [v.name, v.cp]))('%s is dropped', (_name, cp) => {
    expect(cleanText(`a${ch(cp)}b`)).toBe('ab')
    expect(cleanText(`${ch(cp)}${ch(cp)}`)).toBe('')
  })
  it.each(vectors.kept)('%j is kept', text => {
    expect(cleanText(text)).toBe(text)
  })
  it('a blank title falls back to the untitled label', () => {
    const hidden = vectors.hidden.filter(v => v.cp !== '0007').map(v => ch(v.cp)).join('')
    const item = normalizeProposal(raw({ title: hidden }), NOW)
    expect(item.title).toBe('')
    expect(cardView(item, NOW, t).title).toBe('Untitled session')
  })
})

// --- 9 and 10. colours ---------------------------------------------------------------------------------------------------

describe('colours: explicit, readable, always dark on the stage page', async () => {
  const { CSS } = await import('../../src/styles.js')
  const lum = hex => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }
  const rule = selector => {
    const at = CSS.indexOf(selector + ' {')
    expect(at, selector).toBeGreaterThan(-1)
    return CSS.slice(at, CSS.indexOf('}', at))
  }
  const hex = (block, prop) => block.match(new RegExp(`(?:^|[ ;{])${prop}: *(#[0-9a-fA-F]{6})`))[1]

  it('Deny/Negar text on its blue is at least 4.5:1 (default, hover) with explicit colours, not theme variables', () => {
    // `.jh-root button { color: inherit }` has specificity (0,1,1): the colour rule must be at least as specific, or the
    // label inherits the dark theme text and the declared white never shows (the bug in the review screenshots).
    expect(CSS).toContain('.jh-root button { font: inherit; color: inherit; }')
    const base = rule('.jh-root .jh-btn-deny')
    expect(base).not.toMatch(/var\(--ui/)
    expect(ratio(hex(base, 'color'), hex(base, 'background'))).toBeGreaterThanOrEqual(4.5)
    const hover = rule('.jh-root .jh-btn-deny:hover:not(:disabled)')
    expect(ratio(hex(base, 'color'), hex(hover, 'background'))).toBeGreaterThanOrEqual(4.5)
  })

  it('the pending-count badge text is readable on every state colour', () => {
    const badge = rule('.jh-badge')
    const ink = hex(badge, 'color')
    const palette = [...CSS.matchAll(/--jh-p-[a-z]+: (#[0-9a-f]{6})/g)].map(m => m[1])
    expect(palette.length).toBeGreaterThanOrEqual(8)
    for (const color of palette.filter(c => c !== '#64748b')) expect(ratio(ink, color)).toBeGreaterThanOrEqual(4.5)
  })

  it('the stage page is dark whatever the theme: navy ground, dark-safe text, and the state colours are explicit', () => {
    const dark = rule('.jh-dark')
    const navy = CSS.match(/--jh-navy: (#[0-9a-f]{6})/)[1]
    expect(lum(navy)).toBeLessThan(0.02)
    for (const prop of ['--ui-text-primary', '--ui-text-secondary', '--ui-text-tertiary', '--ui-text-quaternary']) {
      expect(ratio(hex(dark, prop), navy), prop).toBeGreaterThanOrEqual(4.5)
    }
    for (const [state, color] of [['idle', '#22d3ee'], ['approval', '#fbbf24'], ['error', '#f87171']]) {
      expect(CSS).toContain(`--jh-p-${state}: ${color}`)
      expect(ratio(color, navy), state).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('the stage page root carries the dark class and keeps reduced motion', () => {
    fakeRuntime()
    expect(CSS).toContain('prefers-reduced-motion: reduce')
    expect(CSS).toContain('.jh-mini { background: var(--jh-navy)')
  })
})
