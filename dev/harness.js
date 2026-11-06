// Dev harness: renders the real views in a plain browser page with a fake Hermes, so the
// reactor and cards can be looked at (and screenshotted) without a running Desktop.
// Not shipped: it is not part of desktop/plugin.js. Build with `npm run harness`.
//
//   ?scene=states            every reactor state side by side (default)
//   ?scene=stage&state=...   the full page, with the store driven into a state
//   ?scene=approval-risky | approval-safe | approval-failed
//   ?scene=agents-empty | agents-error | agents-offline | agents-loading
//   &lang=pt   &theme=light

import { createRoot } from 'react-dom/client'

import { createRuntime } from '../src/runtime.js'
import { CSS } from '../src/styles.js'
import { normalizeList } from '../src/model/agents.js'
import { REACTOR_STATES } from '../src/model/state.js'
import { AgentsPane, ReactorPane, StagePage, StatusItem } from '../src/views/StagePage.js'
import { Reactor } from '../src/views/Reactor.js'
import { SessionCard } from '../src/views/SessionCard.js'
import { h } from '../src/views/h.js'
import { setRuntime } from '../src/views/hooks.js'

const params = new URLSearchParams(location.search)
const scene = params.get('scene') || 'states'
const lang = params.get('lang')
const NOW = Date.now()

document.documentElement.dataset.theme = params.get('theme') === 'light' ? 'light' : 'dark'
const style = document.createElement('style')
style.textContent = CSS
document.head.append(style)

const atom = value => ({ get: () => value, subscribe: fn => { fn(value); return () => {} } })

const prefs = new Map(lang ? [['locale', lang === 'pt' ? 'pt-BR' : 'en']] : [])
const rt = createRuntime({
  request: async (method, p) => {
    if (method === 'session.foreign.list') return sampleList()
    if (method === 'approval.respond') return { resolved: 1 }
    if (method === 'approval.pending') return { approvals: [] }
    throw new Error('no such method in the harness: ' + method)
  },
  onEvent: () => () => {},
  setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); return () => clearTimeout(id) },
  setInterval: (fn, ms) => { const id = setInterval(fn, ms); return () => clearInterval(id) },
  storage: { get: (k, d) => (prefs.has(k) ? prefs.get(k) : d), set: (k, v) => prefs.set(k, v) },
  hostState: { gateway: atom('open'), busy: atom(false), awaitingResponse: atom(false), focusedSessionId: atom('s1'), activeSessionId: atom('s1') },
  notify: n => console.log('notify', n),
  composer: { insertText: async () => true, focus: () => {} },
  navigate: () => {},
  now: () => Date.now()
})
setRuntime(rt)

function sampleList() {
  const mk = (id, source, title, cwd, agoSec, turns) => ({ id: id.repeat(64), source, label: source, title, cwd, mtime: NOW / 1000 - agoSec, turn_count: turns, excerpt: '' })
  return {
    sessions: [
      mk('a', 'claude', 'Fix the auth middleware and run the tests', 'C:\\work\\api-gateway', 45, 18),
      mk('b', 'codex', 'Refactor billing service into modules', 'C:\\work\\billing', 1800, 42),
      mk('c', 'claude', 'Why does the deploy script hang on CI?', '/home/dev/infra', 7200, 9),
      mk('d', 'codex', 'Write migration for the users table', 'C:\\work\\api-gateway', 86400 * 2, 27)
    ],
    next_offset: null,
    host: 'dev',
    unreadable: 0
  }
}

const at = NOW
const dispatch = a => rt.store.dispatch({ at, ...a })
dispatch({ type: 'host', patch: { gateway: 'open', focusedSessionId: 's1' } })
rt.agents.dispatch({ type: 'agents.ok', list: normalizeList(sampleList()), at: NOW })

function drive(state) {
  switch (state) {
    case 'listening': dispatch({ type: 'voice.status', state: 'listening', at: Date.now() }); dispatch({ type: 'voice.partial', text: 'continue the auth session and run', at: Date.now() }); break
    case 'transcribing': dispatch({ type: 'voice.status', state: 'transcribing', at: Date.now() }); break
    case 'thinking': dispatch({ type: 'turn.start', sessionId: 's1', at: Date.now() }); break
    case 'responding': dispatch({ type: 'turn.start', sessionId: 's1', at: Date.now() }); dispatch({ type: 'turn.delta', sessionId: 's1', at: Date.now() }); break
    case 'error': dispatch({ type: 'turn.complete', sessionId: 's1', status: 'error', failure: 'rate limit reached', at: Date.now() }); break
    case 'offline': dispatch({ type: 'host', patch: { gateway: 'closed' } }); break
    case 'approval': dispatch({ type: 'approval.request', sessionId: 's1', requestId: 'r1', command: 'npm test', description: 'run the project tests', choices: ['once', 'session', 'always', 'deny'] }); break
    default: break
  }
}

const approvalScenes = {
  'approval-risky': { command: 'git push --force origin main && rm -rf build', description: 'recursive delete and force push', choices: ['once', 'session', 'always', 'deny'] },
  'approval-safe': { command: 'git status', description: 'read repository state', choices: ['once', 'session', 'always', 'deny'] },
  'approval-unknown': { command: 'make deploy-production', description: 'unrecognised command', choices: ['once', 'session', 'always', 'deny'] }
}

let view
if (scene === 'states') {
  const labels = rt.localePref.get()
  view = h(
    'div',
    { className: 'jh-root', style: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 28, padding: 28 } },
    REACTOR_STATES.map(s =>
      h('div', { key: s, className: 'jh-tint', 'data-state': s, style: { textAlign: 'center' } },
        h(Reactor, { state: s, size: 230, label: s }),
        h('p', { className: 'jh-state-label', style: { marginTop: 22 } }, s)
      )
    ),
    labels ? null : null
  )
} else if (scene === 'stage') {
  drive(params.get('state'))
  view = h('div', { style: { height: '100vh' } }, h(StagePage, null))
} else if (approvalScenes[scene]) {
  dispatch({ type: 'approval.request', sessionId: 's1', requestId: 'r1', ...approvalScenes[scene] })
  view = h('div', { style: { height: '100vh' } }, h(StagePage, null))
} else if (scene === 'approval-failed') {
  dispatch({ type: 'approval.request', sessionId: 's1', requestId: 'r1', ...approvalScenes['approval-unknown'] })
  dispatch({ type: 'approval.failed', key: 's1::r1', reason: 'request timed out: approval.respond' })
  view = h('div', { style: { height: '100vh' } }, h(StagePage, null))
} else if (scene === 'pane') {
  dispatch({ type: 'approval.request', sessionId: 's1', requestId: 'r1', ...approvalScenes['approval-risky'] })
  view = h('div', { style: { display: 'flex', gap: 16, height: '100vh' } },
    h('div', { style: { width: 340, border: '1px solid var(--ui-stroke-secondary)' } }, h(ReactorPane, null)),
    h('div', { style: { width: 340, border: '1px solid var(--ui-stroke-secondary)' } }, h(AgentsPane, null)),
    h('div', { className: 'jh-root', style: { padding: 16 } }, h(StatusItem, null), h(SessionCard, { attrs: { ref: 'a'.repeat(64) }, sessionId: 's1' }))
  )
} else if (scene === 'agents-empty') {
  rt.agents.dispatch({ type: 'agents.ok', list: normalizeList({ sessions: [] }), at: NOW })
  view = h('div', { style: { width: 360, height: '100vh' } }, h(AgentsPane, null))
} else if (scene === 'agents-error') {
  rt.agents.dispatch({ type: 'agents.ok', list: normalizeList({ sessions: [] }), at: NOW })
  rt.agents.dispatch({ type: 'agents.fail', message: 'Could not read session folders on this backend' })
  view = h('div', { style: { width: 360, height: '100vh' } }, h(AgentsPane, null))
} else if (scene === 'agents-loading') {
  view = h('div', { style: { width: 360, height: '100vh' } }, h(AgentsPane, null))
  // Replace the seeded rows with a first-load state.
  rt.agents.dispatch({ type: 'agents.ok', list: normalizeList({ sessions: [] }), at: 0 })
} else if (scene === 'agents-offline') {
  dispatch({ type: 'host', patch: { gateway: 'closed' } })
  view = h('div', { style: { width: 360, height: '100vh' } }, h(AgentsPane, null))
} else {
  view = h('div', null, 'unknown scene')
}

createRoot(document.getElementById('root')).render(view)
