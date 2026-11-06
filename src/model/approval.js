// Approval card model. Pure. Turns a pending approval (from an `approval.request` event
// or from `approval.pending`) into a card, decides which buttons it offers, and holds the
// rules for what counts as a real answer.
//
// Non-negotiable (docs/DESIGN.md):
//  - an approving answer needs a real, trusted click (`isTrusted` and `detail > 0`);
//  - Deny is the focus target, and Esc never approves;
//  - "Always allow" is offered only for a positively read-only command the backend offers;
//  - unknown or unparsable commands are risky.

import { classifyCommand } from './risk.js'
import { cleanBlock, cleanText, cleanWhole, ELLIPSIS, stripUnsafe } from './sanitize.js'

// A command longer than the preview is never approved from the preview alone: the card says how many characters are
// hidden, offers the whole text in a scrollable box, and keeps the approve buttons off until the person opened it.
// Deny is always on. Above FULL_COMMAND_CHARS even the box would be too much to read, so approving is off for good.
export const PREVIEW_CHARS = 900
export const PREVIEW_LINES = 14
export const FULL_COMMAND_CHARS = 20000

export const CHOICES = Object.freeze(['deny', 'once', 'session', 'always'])
export const APPROVING = Object.freeze(['once', 'session', 'always'])

export function cardKey(sessionId, requestId) {
  return `${sessionId}::${requestId}`
}

/**
 * Build a card. Returns null when the request cannot be answered safely (no ids).
 * @param {{ sessionId: string, requestId: string, command?: string, description?: string,
 *   choices?: string[], toolName?: string, hasEdit?: boolean }} input
 * @param {number} now
 */
export function makeCard(input, now = Date.now()) {
  if (!input || typeof input.sessionId !== 'string' || !input.sessionId) return null
  if (typeof input.requestId !== 'string' || !input.requestId) return null

  const rawCommand = typeof input.command === 'string' ? input.command : ''
  let classification = classifyCommand(rawCommand)
  // Hidden control or bidi characters can make a command read differently from what runs.
  // Judge both spellings: dangerous in either one is dangerous, and a command that hides
  // characters is never "read-only".
  const stripped = stripUnsafe(rawCommand)
  if (rawCommand && stripped.replace(/\r/g, '') !== rawCommand.replace(/\r/g, '')) {
    const other = classifyCommand(stripped)
    const tags = Array.from(new Set([...classification.tags, ...other.tags]))
    classification = tags.length > 0 ? { level: 'destructive', tags } : { level: 'unknown', tags: [] }
  }

  // The preview (what the card shows first) and the whole text (what "show all" opens).
  const whole = cleanWhole(rawCommand)
  const wholeChars = Array.from(whole)
  const unviewable = wholeChars.length > FULL_COMMAND_CHARS
  const commandFull = unviewable ? wholeChars.slice(0, FULL_COMMAND_CHARS).join('') : whole
  const preview = cleanBlock(rawCommand, PREVIEW_CHARS, PREVIEW_LINES)
  const lineCount = whole ? whole.split('\n').length : 0
  const clipped = wholeChars.length > PREVIEW_CHARS || lineCount > PREVIEW_LINES
  const shownChars = Array.from(preview.endsWith(ELLIPSIS) ? preview.slice(0, -1) : preview).length
  const hiddenChars = clipped ? Math.max(1, wholeChars.length - shownChars) : 0

  const offered = Array.isArray(input.choices) ? input.choices.filter(c => CHOICES.includes(c)) : []
  const choices = Array.from(new Set(offered.length ? [...offered, 'deny'] : ['once', 'deny']))

  return {
    key: cardKey(input.sessionId, input.requestId),
    sessionId: input.sessionId,
    requestId: input.requestId,
    command: preview,
    commandFull,
    clipped,
    hiddenChars,
    unviewable,
    expanded: false,
    description: cleanText(input.description ?? '', 400),
    toolName: cleanText(input.toolName ?? '', 60),
    choices,
    hasEdit: input.hasEdit === true,
    level: classification.level,
    tags: classification.tags,
    receivedAt: now,
    status: 'pending',
    failure: ''
  }
}

/**
 * The buttons a card offers, in display order. Deny is always first and always present.
 * @returns {{ choice: string, approving: boolean, primary: boolean }[]}
 */
export function buttonsFor(card) {
  const offered = new Set(card.choices)
  const out = [{ choice: 'deny', approving: false, primary: true }]
  if (offered.has('once')) out.push({ choice: 'once', approving: true, primary: false })
  if (offered.has('session') && card.level !== 'destructive') {
    out.push({ choice: 'session', approving: true, primary: false })
  }
  // "Always" only for a command that was positively identified as read-only.
  if (offered.has('always') && card.level === 'safe') {
    out.push({ choice: 'always', approving: true, primary: false })
  }
  return out
}

export function isChoiceAllowed(card, choice) {
  return buttonsFor(card).some(b => b.choice === choice)
}

/** Why an approving answer is not possible yet: '' (it is), 'must_expand' or 'too_long'. Deny is never blocked. */
export function approveBlock(card) {
  if (card.unviewable) return 'too_long'
  if (card.clipped && !card.expanded) return 'must_expand'
  return ''
}

export function isApproving(choice) {
  return APPROVING.includes(choice)
}

/**
 * A real user click on an approving button: trusted by the browser and with at least one
 * click count. Keyboard activation (Enter or Space on a focused button) reports `detail`
 * 0, and a script-made event is not trusted, so neither can approve.
 */
export function isRealClick(event) {
  return Boolean(event) &&
    event.isTrusted === true &&
    event.type === 'click' &&
    typeof event.detail === 'number' &&
    event.detail > 0
}

/** Deny is safe, so any trusted activation (mouse or keyboard) may deny. */
export function isTrustedGesture(event) {
  return Boolean(event) && event.isTrusted === true
}

/**
 * Whether the card may pull keyboard focus to Deny. Never steal focus from somewhere the
 * user is typing: only when nothing is focused or focus is already inside our own UI.
 */
export function shouldTakeFocus({ activeIsBody, activeInsideRoot }) {
  return Boolean(activeIsBody || activeInsideRoot)
}

/** The three plain-language sections of a card, as translated text. */
export function explain(card, t) {
  const may = []
  if (card.level === 'safe') {
    may.push(t('approval.may.safe'))
  } else if (card.level === 'destructive') {
    may.push(t('approval.may.destructive'))
    for (const tag of card.tags) {
      const key = `approval.tag.${tag}`
      const text = t(key)
      if (text !== key) may.push(text)
    }
  } else {
    may.push(t('approval.may.unknown'))
  }
  return {
    what: (card.expanded ? card.commandFull : card.command) || t('approval.noCommand'),
    may,
    why: card.description || t('approval.noWhy'),
    riskLabel: t(`approval.risk.${card.level}`)
  }
}
