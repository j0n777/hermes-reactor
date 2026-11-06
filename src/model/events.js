// Gateway event -> plain action. Pure and defensive: payloads are untrusted, any field
// may be missing or the wrong type. Returns null for events this plugin ignores.

import { cleanText } from './sanitize.js'

/** Every event type this plugin subscribes to. */
export const WATCHED_EVENT_TYPES = Object.freeze([
  'wake.detected',
  'voice.status',
  'voice.partial',
  'voice.transcript',
  'voice.interrupted',
  'message.start',
  'message.delta',
  'message.interim',
  'message.complete',
  'reasoning.delta',
  'reasoning.available',
  'thinking.delta',
  'tool.start',
  'tool.generating',
  'tool.progress',
  'tool.complete',
  'subagent.start',
  'subagent.progress',
  'subagent.thinking',
  'subagent.tool',
  'error',
  'approval.request',
  'approval.settled',
  'approval.cancelled'
])

const THINKING_EVENTS = new Set([
  'reasoning.delta',
  'reasoning.available',
  'thinking.delta',
  'tool.start',
  'tool.generating',
  'tool.progress',
  'tool.complete',
  'subagent.start',
  'subagent.progress',
  'subagent.thinking',
  'subagent.tool'
])

const VOICE_ALIASES = {
  idle: 'idle',
  listening: 'listening',
  recording: 'listening',
  transcribing: 'transcribing',
  processing: 'transcribing'
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function str(value, max = 300) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

export function normalizeVoiceState(value) {
  if (typeof value !== 'string') return 'idle'
  return VOICE_ALIASES[value.trim().toLowerCase()] ?? 'idle'
}

/**
 * @param {{ type?: unknown, session_id?: unknown, payload?: unknown, replayed?: unknown }} event
 * @param {number} now epoch ms
 */
export function toAction(event, now) {
  const e = record(event)
  const type = typeof e.type === 'string' ? e.type : ''
  if (!type) return null
  const payload = record(e.payload)
  const sessionId = typeof e.session_id === 'string' ? e.session_id.slice(0, 200) : ''
  const replayed = e.replayed === true

  // Approval events always matter, even replayed ones (they restore a pending card).
  if (type === 'approval.request') {
    const requestId = str(payload.prompt_id, 200) || str(payload.request_id, 200)
    if (!requestId || !sessionId) return null
    return {
      type: 'approval.request',
      at: now,
      sessionId,
      requestId,
      command: typeof payload.command === 'string' ? payload.command.slice(0, 20000) : '',
      description: typeof payload.description === 'string' ? payload.description.slice(0, 4000) : '',
      choices: Array.isArray(payload.choices) ? payload.choices.filter(c => typeof c === 'string').slice(0, 8) : [],
      toolName: str(payload.tool_name, 80),
      hasEdit: payload.edit !== undefined && payload.edit !== null
    }
  }
  if (type === 'approval.settled') {
    const requestId = str(payload.prompt_id, 200) || str(payload.request_id, 200)
    if (!requestId) return null
    return { type: 'approval.settled', at: now, sessionId, requestId }
  }
  if (type === 'approval.cancelled') {
    const ids = Array.isArray(payload.request_ids) ? payload.request_ids.filter(i => typeof i === 'string').slice(0, 50) : []
    return {
      type: 'approval.cancelled',
      at: now,
      sessionId: str(payload.session_id, 200) || sessionId,
      requestIds: ids,
      count: Number.isFinite(payload.cancelled_count) ? Number(payload.cancelled_count) : ids.length
    }
  }

  // Everything else describes live activity: a replayed frame is history, not now.
  if (replayed) return null

  switch (type) {
    case 'wake.detected':
      return { type: 'wake', at: now }
    case 'voice.status':
      return { type: 'voice.status', at: now, state: normalizeVoiceState(payload.state) }
    case 'voice.partial':
      return { type: 'voice.partial', at: now, text: cleanText(payload.text, 240) }
    case 'voice.transcript':
      return {
        type: 'voice.transcript',
        at: now,
        text: cleanText(payload.text, 240),
        stopPhrase: payload.stop_phrase === true,
        noSpeech: payload.no_speech_limit === true
      }
    case 'voice.interrupted':
      return { type: 'voice.interrupted', at: now }
    case 'message.start':
      return { type: 'turn.start', at: now, sessionId }
    case 'message.delta':
    case 'message.interim': {
      const has = (typeof payload.text === 'string' && payload.text.length > 0) ||
        (typeof payload.rendered === 'string' && payload.rendered.length > 0)
      return has ? { type: 'turn.delta', at: now, sessionId } : null
    }
    case 'message.complete': {
      const status = payload.status === 'error' || payload.status === 'interrupted' ? payload.status : 'complete'
      return {
        type: 'turn.complete',
        at: now,
        sessionId,
        status,
        failure: cleanText(payload.failure_reason ?? payload.error ?? '', 120)
      }
    }
    case 'error':
      return { type: 'error', at: now, sessionId, message: cleanText(payload.message, 160) }
    default:
      if (THINKING_EVENTS.has(type)) {
        // Proved live (Hermes 0.23.0): a stream ends with a trailing `thinking.delta` whose text is empty,
        // after the answer text began. It carries no thought, so it must not pull "responding" back.
        if ((type === 'thinking.delta' || type === 'reasoning.delta') && typeof payload.text === 'string' && payload.text.trim() === '') return null
        return { type: 'turn.thinking', at: now, sessionId }
      }
      return null
  }
}

/** Build the action for a pending approval returned by `approval.pending`. */
export function pendingToItem(raw) {
  const p = record(raw)
  const requestId = str(p.request_id, 200)
  if (!requestId) return null
  return {
    requestId,
    command: typeof p.command === 'string' ? p.command.slice(0, 20000) : '',
    description: typeof p.description === 'string' ? p.description.slice(0, 4000) : '',
    choices: Array.isArray(p.choices) ? p.choices.filter(c => typeof c === 'string').slice(0, 8) : [],
    toolName: str(p.tool_name, 80),
    hasEdit: false
  }
}
