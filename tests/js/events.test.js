import { describe, expect, it } from 'vitest'
import { WATCHED_EVENT_TYPES, normalizeVoiceState, pendingToItem, toAction } from '../../src/model/events.js'

const NOW = 1_000

describe('toAction: voice and wake', () => {
  it('maps wake.detected', () => {
    expect(toAction({ type: 'wake.detected', payload: { phrase: 'jarbas', start_new_session: true } }, NOW)).toEqual({ type: 'wake', at: NOW })
  })
  it('maps voice.status states and aliases', () => {
    expect(toAction({ type: 'voice.status', payload: { state: 'listening' } }, NOW).state).toBe('listening')
    expect(toAction({ type: 'voice.status', payload: { state: 'transcribing' } }, NOW).state).toBe('transcribing')
    expect(toAction({ type: 'voice.status', payload: { state: 'recording' } }, NOW).state).toBe('listening')
    expect(toAction({ type: 'voice.status', payload: { state: 'weird' } }, NOW).state).toBe('idle')
    expect(toAction({ type: 'voice.status', payload: {} }, NOW).state).toBe('idle')
  })
  it('cleans partial and transcript text', () => {
    expect(toAction({ type: 'voice.partial', payload: { text: 'he‮llo\u0000' } }, NOW).text).toBe('hello')
    const t = toAction({ type: 'voice.transcript', payload: { text: ' ok ', stop_phrase: true, no_speech_limit: false } }, NOW)
    expect(t).toMatchObject({ text: 'ok', stopPhrase: true, noSpeech: false })
  })
  it('maps voice.interrupted', () => {
    expect(toAction({ type: 'voice.interrupted' }, NOW).type).toBe('voice.interrupted')
  })
})

describe('toAction: turns', () => {
  it('maps message.start, delta and complete with the session id', () => {
    expect(toAction({ type: 'message.start', session_id: 's1', payload: {} }, NOW)).toEqual({ type: 'turn.start', at: NOW, sessionId: 's1' })
    expect(toAction({ type: 'message.delta', session_id: 's1', payload: { text: 'hi' } }, NOW).type).toBe('turn.delta')
    expect(toAction({ type: 'message.complete', session_id: 's1', payload: { status: 'complete' } }, NOW)).toMatchObject({ type: 'turn.complete', status: 'complete' })
    expect(toAction({ type: 'message.complete', session_id: 's1', payload: { status: 'error', failure_reason: 'rate limit' } }, NOW)).toMatchObject({ status: 'error', failure: 'rate limit' })
    expect(toAction({ type: 'message.complete', payload: { status: 'interrupted' } }, NOW).status).toBe('interrupted')
  })
  it('ignores empty deltas', () => {
    expect(toAction({ type: 'message.delta', payload: { text: null } }, NOW)).toBeNull()
    expect(toAction({ type: 'message.delta', payload: { text: '' } }, NOW)).toBeNull()
    expect(toAction({ type: 'message.delta', payload: {} }, NOW)).toBeNull()
  })
  it('treats reasoning and tool activity as thinking', () => {
    for (const type of ['reasoning.delta', 'thinking.delta', 'tool.start', 'tool.progress', 'subagent.progress']) {
      expect(toAction({ type, session_id: 's', payload: {} }, NOW).type).toBe('turn.thinking')
    }
  })
  it('ignores the empty trailing thinking.delta Hermes 0.23.0 sends after the answer began (proved live)', () => {
    expect(toAction({ type: 'thinking.delta', session_id: 's', payload: { text: '' } }, NOW)).toBeNull()
    expect(toAction({ type: 'thinking.delta', session_id: 's', payload: { text: 'hm' } }, NOW).type).toBe('turn.thinking')
  })
  it('maps tool.generating and tool.complete as thinking', () => {
    for (const type of ['tool.generating', 'tool.complete']) {
      expect(toAction({ type, session_id: 's', payload: { name: 'terminal' } }, NOW).type).toBe('turn.thinking')
    }
  })
  it('maps error events', () => {
    expect(toAction({ type: 'error', payload: { message: 'boom' } }, NOW)).toMatchObject({ type: 'error', message: 'boom' })
  })
  it('ignores replayed activity frames', () => {
    expect(toAction({ type: 'message.start', replayed: true, session_id: 's' }, NOW)).toBeNull()
    expect(toAction({ type: 'voice.status', replayed: true, payload: { state: 'listening' } }, NOW)).toBeNull()
    expect(toAction({ type: 'wake.detected', replayed: true, payload: {} }, NOW)).toBeNull()
  })
})

describe('toAction: approvals', () => {
  it('maps approval.request using prompt_id', () => {
    const a = toAction({ type: 'approval.request', session_id: 's1', payload: { prompt_id: 'p1', command: 'ls', description: 'list', choices: ['once', 'deny', 7] } }, NOW)
    expect(a).toMatchObject({ type: 'approval.request', sessionId: 's1', requestId: 'p1', command: 'ls', choices: ['once', 'deny'], hasEdit: false })
  })
  it('accepts request_id as a fallback and marks edit payloads', () => {
    const a = toAction({ type: 'approval.request', session_id: 's1', payload: { request_id: 'r9', edit: { a: 1 } } }, NOW)
    expect(a).toMatchObject({ requestId: 'r9', hasEdit: true })
  })
  it('rejects approval.request without ids', () => {
    expect(toAction({ type: 'approval.request', session_id: 's1', payload: {} }, NOW)).toBeNull()
    expect(toAction({ type: 'approval.request', payload: { prompt_id: 'p' } }, NOW)).toBeNull()
  })
  it('keeps replayed approval requests (they restore a pending card)', () => {
    expect(toAction({ type: 'approval.request', replayed: true, session_id: 's', payload: { prompt_id: 'p' } }, NOW)).not.toBeNull()
  })
  it('maps settled and cancelled', () => {
    expect(toAction({ type: 'approval.settled', payload: { prompt_id: 'p1' } }, NOW)).toMatchObject({ type: 'approval.settled', requestId: 'p1' })
    expect(toAction({ type: 'approval.settled', payload: {} }, NOW)).toBeNull()
    const c = toAction({ type: 'approval.cancelled', session_id: 's', payload: { session_id: 's', request_ids: ['a', 'b', 3], cancelled_count: 2 } }, NOW)
    expect(c).toMatchObject({ type: 'approval.cancelled', sessionId: 's', requestIds: ['a', 'b'], count: 2 })
  })
})

describe('toAction: robustness', () => {
  it('returns null for unknown or malformed events', () => {
    expect(toAction(null, NOW)).toBeNull()
    expect(toAction(undefined, NOW)).toBeNull()
    expect(toAction({}, NOW)).toBeNull()
    expect(toAction({ type: 42 }, NOW)).toBeNull()
    expect(toAction({ type: 'session.title', payload: {} }, NOW)).toBeNull()
    expect(toAction({ type: 'voice.status', payload: 'x' }, NOW).state).toBe('idle')
  })
  it('watches exactly the types it can map', () => {
    for (const type of WATCHED_EVENT_TYPES) {
      const payload = type.startsWith('approval') ? { prompt_id: 'p', request_ids: [] } : { text: 'x' }
      expect(toAction({ type, session_id: 's', payload }, NOW), type).not.toBeNull()
    }
  })
})

describe('normalizeVoiceState', () => {
  it('defaults to idle', () => {
    expect(normalizeVoiceState(undefined)).toBe('idle')
    expect(normalizeVoiceState('LISTENING')).toBe('listening')
  })
})

describe('pendingToItem', () => {
  it('needs a request_id', () => {
    expect(pendingToItem({ command: 'ls' })).toBeNull()
    expect(pendingToItem({ request_id: 'r', command: 'ls', choices: ['once', 'deny'] })).toMatchObject({ requestId: 'r', command: 'ls' })
    expect(pendingToItem(null)).toBeNull()
  })
})
