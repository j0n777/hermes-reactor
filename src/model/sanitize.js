// Untrusted text handling. Session titles, excerpts, commands, error strings and
// voice text all come from outside this plugin. Everything shown goes through here
// first, and is rendered as plain text (never as markup).

// Removed: C0 and C1 controls (newline and tab are kept), DEL, EVERY format character (Unicode category Cf: bidi
// controls and isolates, zero-width characters, soft hyphen, BOM, interlinear marks, the unicode tag block and the
// rest), private use, line and paragraph separators, variation selectors, and the characters that are not Cf but draw
// as blanks (HIDDEN_FILLERS below). Keep HIDDEN_FILLERS identical to _BLANK_FILLERS in reactor_hermes/text.py;
// tests/shared/sanitize-vectors.json runs one list through both.
export const HIDDEN_FILLERS = Object.freeze([0x3164, 0xffa0, 0x115f, 0x1160, 0x180b, 0x180c, 0x180d])
const FILLER_CLASS = HIDDEN_FILLERS.map(cp => '\\u{' + cp.toString(16) + '}').join('')
const UNSAFE = new RegExp(
  '[' +
    '\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F' +
    '\\u007F-\\u009F' +
    '\\p{Cf}\\p{Co}' +
    '\\u2028-\\u202E\\u2060-\\u206F' +
    '\\uFE00-\\uFE0F\\u{E0100}-\\u{E01EF}' +
    FILLER_CLASS +
    ']',
  'gu'
)

const LONE_SURROGATE = new RegExp('[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]', 'g')

export const ELLIPSIS = '…'

function asString(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** Remove control, bidi, zero-width and tag characters. Keeps \n and \t. */
export function stripUnsafe(value) {
  return asString(value).replace(LONE_SURROGATE, '�').replace(UNSAFE, '')
}

/** Cap by code points (never splits a surrogate pair). */
export function capLength(text, max) {
  const limit = Math.max(1, Math.floor(max))
  const chars = Array.from(text)
  if (chars.length <= limit) return text
  return chars.slice(0, limit - 1).join('').trimEnd() + ELLIPSIS
}

/** One line of safe text: unsafe characters removed, whitespace collapsed, capped. */
export function cleanText(value, max = 200) {
  const flat = stripUnsafe(value).normalize('NFC').replace(/\s+/g, ' ').trim()
  return capLength(flat, max)
}

/**
 * A block with unsafe characters removed and line breaks normalised, NOT clipped. For text that must be shown whole
 * or not at all (an approval command, an instruction). Trailing spaces on a line are kept: they are part of the text.
 */
export function cleanWhole(value) {
  return stripUnsafe(value).normalize('NFC').replace(/\r\n?/g, '\n').trim()
}

/** A short block (a command, an excerpt): keeps line breaks, bounded in lines and size. */
export function cleanBlock(value, maxChars = 800, maxLines = 12) {
  const text = stripUnsafe(value).normalize('NFC').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim()
  if (!text) return ''
  const lines = text.split('\n')
  let clipped = false
  let kept = lines
  if (lines.length > maxLines) {
    kept = lines.slice(0, maxLines)
    clipped = true
  }
  let joined = kept.join('\n')
  if (Array.from(joined).length > maxChars) {
    joined = Array.from(joined).slice(0, maxChars - 1).join('').trimEnd()
    clipped = true
  }
  return clipped ? joined + ELLIPSIS : joined
}

/** Last path segment, safe to show. Works for both separators. */
export function folderName(path, max = 60) {
  const clean = cleanText(path, 400)
  if (!clean) return ''
  const trimmed = clean.replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/)
  const last = parts[parts.length - 1] || trimmed
  return capLength(last, max)
}

/** True when the text, after cleaning, still contains something visible. */
export function hasContent(value) {
  return cleanText(value, 4).length > 0
}
