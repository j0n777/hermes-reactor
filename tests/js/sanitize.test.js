import { describe, expect, it } from 'vitest'
import { capLength, cleanBlock, cleanText, folderName, hasContent, stripUnsafe } from '../../src/model/sanitize.js'

describe('stripUnsafe', () => {
  it('removes control characters but keeps newline and tab', () => {
    expect(stripUnsafe('a\u0000b\u0007c\u001bd\ne\tf')).toBe('abcd\ne\tf')
  })
  it('removes C1 controls and DEL', () => {
    expect(stripUnsafe('a\u007fb\u0085c\u009fd')).toBe('abcd')
  })
  it('removes bidi overrides and isolates', () => {
    expect(stripUnsafe('safe\u202Egnp.exe\u202C\u2066x\u2069\u200F\u061C')).toBe('safegnp.exex')
  })
  it('removes zero-width and BOM characters', () => {
    expect(stripUnsafe('a\u200Bb\u200Cc\u200Dd\u2060e\uFEFFf')).toBe('abcdef')
  })
  it('removes the unicode tag block used to hide instructions', () => {
    const hidden = String.fromCodePoint(0xe0049, 0xe0067, 0xe006e, 0xe006f, 0xe0072, 0xe0065)
    expect(stripUnsafe(`hello${hidden}world`)).toBe('helloworld')
  })
  it('removes variation selectors', () => {
    expect(stripUnsafe('a\uFE0Fb')).toBe('ab')
  })
  it('replaces lone surrogates', () => {
    expect(stripUnsafe('a\uD800b')).toBe('a\uFFFDb')
  })
  it('turns non-strings into empty text', () => {
    expect(stripUnsafe(undefined)).toBe('')
    expect(stripUnsafe(null)).toBe('')
    expect(stripUnsafe({})).toBe('')
    expect(stripUnsafe(42)).toBe('42')
  })
})

describe('cleanText', () => {
  it('collapses whitespace and trims', () => {
    expect(cleanText('  a \n\n b\t\tc  ')).toBe('a b c')
  })
  it('caps by code points without splitting a surrogate pair', () => {
    const out = cleanText('😀'.repeat(10), 5)
    expect(Array.from(out).length).toBe(5)
    expect(out.endsWith('\u2026')).toBe(true)
    expect(out).not.toMatch(/[\uD800-\uDBFF]$/)
  })
  it('leaves markup as inert text (it is rendered as text, never as HTML)', () => {
    expect(cleanText('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>')
  })
})

describe('capLength', () => {
  it('leaves short text alone', () => {
    expect(capLength('abc', 5)).toBe('abc')
  })
  it('clips with an ellipsis', () => {
    expect(capLength('abcdefgh', 5)).toBe('abcd\u2026')
  })
})

describe('cleanBlock', () => {
  it('keeps line breaks and normalises CRLF', () => {
    expect(cleanBlock('a\r\nb\r\nc')).toBe('a\nb\nc')
  })
  it('bounds lines', () => {
    const out = cleanBlock(Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n'), 800, 5)
    expect(out.split('\n').length).toBe(5)
    expect(out.endsWith('\u2026')).toBe(true)
  })
  it('bounds characters', () => {
    const out = cleanBlock('x'.repeat(2000), 100, 5)
    expect(Array.from(out).length).toBeLessThanOrEqual(100)
  })
  it('returns empty for nothing', () => {
    expect(cleanBlock('')).toBe('')
    expect(cleanBlock(undefined)).toBe('')
  })
})

describe('folderName', () => {
  it('handles both separators and trailing slashes', () => {
    expect(folderName('C:\\Users\\me\\proj\\')).toBe('proj')
    expect(folderName('/home/me/proj')).toBe('proj')
    expect(folderName('')).toBe('')
  })
  it('is safe against bidi tricks', () => {
    expect(folderName('/x/evil\u202Egpj.txt')).toBe('evilgpj.txt')
  })
})

describe('hasContent', () => {
  it('is false for invisible-only text', () => {
    expect(hasContent('\u200B\u202E ')).toBe(false)
    expect(hasContent('a')).toBe(true)
  })
})
