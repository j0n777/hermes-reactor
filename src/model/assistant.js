// The assistant's display name. Free text, 1 to 24 characters, reduced to letters, digits, marks, space, hyphen,
// underscore, apostrophe and period. Keep identical to sanitize_name in reactor_hermes/assistant.py;
// tests/shared/name-vectors.json runs one list through both.
//
// The choice lives in the plugin's own storage and is pushed to the Python backend (in memory only), which hands the model
// a one-line persona through the documented `pre_llm_call` context. Nothing here touches a persona file or a profile.

import { stripUnsafe } from './sanitize.js'

export const DEFAULT_NAME = 'Hermes'
export const PRESETS = Object.freeze(['Hermes', 'Jarbas'])
export const NAME_MAX = 24

const KEEP = /^[\p{L}\p{N}\p{M} \-_'.]$/u

export function sanitizeName(value) {
  if (typeof value !== 'string') return ''
  // Line breaks and tabs become spaces first (the Python side does the same), then everything unsafe goes.
  const flat = stripUnsafe(value.replace(/[\r\n\t]/g, ' ')).normalize('NFC')
  const kept = Array.from(flat).filter(ch => KEEP.test(ch)).join('')
  const text = kept.replace(/\s+/g, ' ').trim()
  const chars = Array.from(text)
  return chars.length > NAME_MAX ? chars.slice(0, NAME_MAX).join('').trimEnd() : text
}

export function assistantInitial() {
  return { name: DEFAULT_NAME, synced: false }
}

export function assistantReduce(state, action) {
  switch (action.type) {
    case 'assistant.set':
      return state.name === action.name && state.synced === (action.synced ?? false) ? state : { name: action.name, synced: action.synced ?? false }
    case 'assistant.synced':
      return state.synced === action.synced ? state : { ...state, synced: action.synced }
    default:
      return state
  }
}

/**
 * @param {{ getState: () => { name: string, synced: boolean }, dispatch: (a: object) => void,
 *   rest: (path: string, opts?: object) => Promise<any>, storage: { get: Function, set: Function } }} deps
 */
export function createAssistantController({ getState, dispatch, rest, storage }) {
  function load() {
    let saved = ''
    try {
      saved = sanitizeName(storage.get('assistantName', ''))
    } catch {
      saved = ''
    }
    dispatch({ type: 'assistant.set', name: saved || DEFAULT_NAME, synced: false })
    return getState()
  }

  async function push() {
    const name = getState().name
    try {
      const res = await rest('/assistant', { method: 'POST', body: { name } })
      const ok = Boolean(res) && res.ok === true
      dispatch({ type: 'assistant.synced', synced: ok })
      return { ok }
    } catch {
      dispatch({ type: 'assistant.synced', synced: false })
      return { ok: false }
    }
  }

  async function set(value) {
    const name = sanitizeName(value)
    if (!name) return { ok: false, reason: 'bad_name' }
    try {
      storage.set('assistantName', name)
    } catch {
      // Not persisted; still applied for this session.
    }
    dispatch({ type: 'assistant.set', name, synced: false })
    await push()
    return { ok: true, name }
  }

  return { load, push, set }
}
