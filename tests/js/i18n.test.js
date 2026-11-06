import { describe, expect, it } from 'vitest'
import { LOCALES, MESSAGES, makeT, normalizeLocale, resolveLocale } from '../../src/model/i18n.js'

const placeholders = text => (text.match(/\{\w+\}/g) || []).sort()

describe('catalogs', () => {
  it('have the same keys in every locale', () => {
    const en = Object.keys(MESSAGES.en).sort()
    for (const locale of LOCALES) {
      expect(Object.keys(MESSAGES[locale]).sort()).toEqual(en)
    }
  })
  it('keep the same placeholders per key', () => {
    for (const key of Object.keys(MESSAGES.en)) {
      expect(placeholders(MESSAGES['pt-BR'][key]), key).toEqual(placeholders(MESSAGES.en[key]))
    }
  })
  it('have no empty strings', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(MESSAGES[locale])) {
        expect(value.trim().length, `${locale}:${key}`).toBeGreaterThan(0)
      }
    }
  })
  it('never name a film brand', () => {
    const all = JSON.stringify(MESSAGES).toLowerCase()
    expect(all).not.toContain('jarvis')
    expect(all).not.toContain('stark')
  })
})

describe('normalizeLocale', () => {
  it('maps Portuguese variants to pt-BR', () => {
    for (const v of ['pt', 'pt-BR', 'pt_br', 'PT-pt', ' pt ']) expect(normalizeLocale(v)).toBe('pt-BR')
  })
  it('maps English variants to en', () => {
    for (const v of ['en', 'en-US', 'EN_gb']) expect(normalizeLocale(v)).toBe('en')
  })
  it('returns null for others and non-strings', () => {
    expect(normalizeLocale('fr')).toBeNull()
    expect(normalizeLocale(undefined)).toBeNull()
    expect(normalizeLocale('')).toBeNull()
  })
})

describe('resolveLocale', () => {
  it('honours an explicit preference first', () => {
    expect(resolveLocale({ preference: 'pt-BR', appLocale: 'en' })).toBe('pt-BR')
    expect(resolveLocale({ preference: 'en', appLocale: 'pt', navigatorLanguages: ['pt-BR'] })).toBe('en')
  })
  it('follows the Hermes locale', () => {
    expect(resolveLocale({ appLocale: 'pt' })).toBe('pt-BR')
  })
  it('uses the system language only when Hermes reports plain English', () => {
    expect(resolveLocale({ appLocale: 'en', navigatorLanguages: ['pt-BR', 'en'] })).toBe('pt-BR')
    expect(resolveLocale({ appLocale: null, navigatorLanguages: ['pt'] })).toBe('pt-BR')
    expect(resolveLocale({ appLocale: 'fr', navigatorLanguages: ['pt-BR'] })).toBe('en')
  })
  it('falls back to English', () => {
    expect(resolveLocale({})).toBe('en')
    expect(resolveLocale({ appLocale: 'en', navigatorLanguages: ['en-US', 'pt-BR'] })).toBe('en')
  })
})

describe('makeT', () => {
  it('interpolates', () => {
    expect(makeT('en')('agents.turns', { n: 3 })).toBe('3 turns')
    expect(makeT('pt-BR')('agents.turns', { n: 3 })).toBe('3 turnos')
  })
  it('falls back to English then to the key', () => {
    expect(makeT('xx')('state.idle')).toBe('Standing by')
    expect(makeT('en')('no.such.key')).toBe('no.such.key')
  })
  it('keeps unknown placeholders visible', () => {
    expect(makeT('en')('agents.turns', {})).toBe('{n} turns')
  })
})
