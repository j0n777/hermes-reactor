# Reactor for Hermes: design

A Hermes Agent plugin (id `hermes-reactor`, display name "Reactor"): a live graph of your profiles, sessions and subagents, a
reactor visual that shows what Hermes is doing, voice-requested screens, cards that wait for your click, and a named
assistant. It descends from the author's Jarbas project (a standalone voice assistant); nothing else is shared.
Target: Hermes Agent Plugin Hackathon, due 2026-11-11 17:00 EST. Judged on usefulness, reliability, polish, creativity.
Hermes source for reference: a v0.23.0 checkout kept in a private lab folder (not part of this repository).

## What it does

1. **Live agent graph:** the Hermes reactor in the middle; around it your profiles, the sessions that are doing something and the
   subagents they spawn, joined parent to child. Status colours and glyphs, a side panel with goal, model, last tool, tokens
   and duration. A wake lights the profile that was woken.
2. **Reactor:** a large animated reactor shows what Hermes is doing: idle, listening, transcribing, thinking, responding,
   waiting for approval, error.
3. **Voice-requested screens:** the model can open a closed list of screens (`reactor_show`).
4. **Talk to any profile:** the model drafts a message for another profile (`reactor_ask_profile`); a card shows the exact
   text and you click Send.
5. **Agents panel and spoken orchestration:** Claude Code and Codex sessions, briefings, and a continue that runs only after
   your click.
6. **Approval cards:** every Hermes approval as a large card saying what it does and what may happen. Answers are by click only.
7. **Kanban, read only:** a status line and card badges that show worker states. No writes.
8. **A name:** the assistant answers to a name you choose (default "Hermes").

Hermes supplies wake word, STT, TTS, sessions, approvals and auth. This plugin never re-implements them.

## Layout (single repo, plugin at root)

```
plugin.yaml, __init__.py, README.md, LICENSE (MIT)
reactor_hermes/       python: tools, session resolver, risk classifier, proposals, asks, assistant name, screens, kanban observers,
                      runner (the only module that starts a program), setup command
dashboard/            manifest.json + plugin_api.py: /api/plugins/hermes-reactor routes (proposals, asks, assistant name)
skills/reactor/       persona and orchestration skill
desktop/plugin.js     built artifact, committed, unminified
src/                  JS source: pure model modules + React views (jsx()/jsxs(), no JSX)
tests/py, tests/js, tests/shared
```

The names `jh-` (CSS prefix) and the `reactor_hermes` package are internal. The core Desktop route `/command-center` exists; this
plugin's page is `/reactor`.

## Python surface

- `reactor_list_sessions(query?, limit?)`: compact rows `{ref, agent, title, folder, age, turns}`. `ref` is opaque.
- `reactor_session_brief(ref)`: a bounded excerpt wrapped as untrusted data.
- `reactor_continue_session(ref, instruction)`: validates, keeps a single-use proposal in server memory (5 minutes) and returns
  only `{status: "awaiting_click", proposal_ref}`. Runs nothing. See "Continue flow".
- `reactor_explain_risk(command)`: pure classifier; no execution.
- `reactor_show(view)`: `view` is one of `stage`, `graph`, `agents`, `profiles`, `kanban`, `cron`, `messaging`, `capabilities`.
  Sends one plugin event (`plugin.hermes-reactor.show`) through `hermes_cli.plugin_events.broadcast_plugin_event`, the documented
  door. An unknown view does nothing.
- `reactor_ask_profile(profile, message)`: validates (strict profile name, the profile exists, the message cleaned and under
  4000 characters and 40 lines) and keeps a single-use ask in memory (5 minutes, at most 5 pending). Returns only
  `{status: "awaiting_click", proposal_ref}`. Sends nothing.
- Hooks: `pre_llm_call` returns one context line (the assistant name and "reply in the user's language"); the four Kanban
  observers `kanban_task_claimed`, `kanban_task_completed`, `kanban_task_blocked`, `on_kanban_task_updated` forward ids and a
  state, never task text.
- `hermes reactor setup`: shows, and on confirmation applies, the PT-BR voice config. The default never touches disk.
- Discovery uses `hermes_cli.foreign_sessions.gather_foreign_sessions()` behind one adapter module with a version guard; this
  draws a validator warning and is disclosed in the README.

## Desktop surface

- `ROUTES_AREA` page `/reactor` + sidebar row: the graph, the reactor stage, side cards.
- Pane: a compact reactor with the cards. Agents pane. Status bar item: mini reactor with a badge for what needs a click.
- Chat directives: `::reactor-session{ref="..."}` (a session card) and `::reactor-show{view="..."}` (a button; rendering never
  navigates, a click does).
- `KANBAN_CARD_AREAS.badges`: "Reactor: working | done | blocked" on cards whose state was seen, tooltip ends with the plugin name.

### The graph (src/model/graph.js, graph-controller.js, views/GraphView.js)

Pure model, tested without a DOM. Sources:

| Source | Used for |
|---|---|
| `subagent.spawn_requested`, `.start`, `.thinking`, `.tool`, `.progress`, `.complete` events | live nodes and their status |
| `wake.detected` (its `profile`, else the default profile) | lights a profile node for 6 seconds |
| `message.start`, `.delta`, `.complete` | which sessions are active, under which profile |
| `host.profiles.list()` and `host.profileRoutes()` | profile nodes, including profiles served by another connection |
| `delegation.status` | authoritative list of what is ACTIVE: a child missing from it is no longer running (`unknown`, drawn dashed) |
| `subagent.list` | the focused session's children |
| `spawn_tree.list` / `spawn_tree.load` | the newest saved tree, once per connection, as ended history |

Rules the tests pin: a finished agent never comes back to life from a late event; an event for an unknown id creates it; an
unknown parent id hangs the node from its session; a parent cycle is cut; at most 300 agents are kept and 60 nodes drawn
(running first, ancestors kept, the rest counted as "+N more"); after a reconnect running agents are `stale` (dimmed) until a
snapshot confirms them; text from agents is cleaned and drawn as text. Layout is a deterministic radial tree.

### Ask another profile (src/model/asks.js, reactor_hermes/asks.py)

1. The tool registers the ask in server memory and returns a label. The model never gets the id, the text, or anything that
   can trigger it.
2. A card names the target profile, shows the exact text and says the profile has its own tools. Deny holds the focus; Send needs
   a real click (`isTrusted`, `click`, `detail > 0`).
3. On the click Desktop first finds the profile's route (`host.profileRoutes()`; a missing or ambiguous route releases nothing),
   then asks the backend to release the ask (single use, text wiped), then sends:
   `session.create`, `prompt.submit` and `session.history` through `host.requestProfile`, holding `host.retainProfile` for the
   whole exchange and letting it go in a `finally`.
4. Why not `bot_relay.deliver`: it is the Bot Chat bridge (delivery id, roster, the target's own authority, a mailbox receipt)
   and a failure leaves a retained envelope. The plain session RPCs are the ones the Desktop itself uses.
5. The reply is untrusted text, cleaned and capped, shown on the card, never put in the chat and never returned to the model.

### State model (pure, unit tested)

Built from the signals a plugin really receives in Hermes Desktop 0.23.0 (proved live in the lab, see docs/media):
- `wake.detected` enters `listening`. It ends when a turn starts (`message.start`) or after a bounded 20 s.
- `thinking` comes from `host.state.busy` / `awaitingResponse` and from `thinking.delta` (non-empty), `tool.*` and `subagent.*`
  events. Hermes ends a stream with an empty `thinking.delta` after the answer began; it is ignored.
- `responding` comes from `message.delta`; `message.complete` returns to `idle` (or `error`).
- `approval.request|settled|cancelled` drive the approval card. `approval.respond` takes the id as `request_id`.
- `voice.*` events did NOT fire in the Desktop voice flow (it captures in the renderer). The handlers stay, harmless.
There is no speaking signal available to plugins, so there is no speaking state at all. Audio level is unavailable, so the
animation is state-driven. Never fake a live meter.

## The assistant name

Free text, 1 to 24 characters, reduced to letters, digits, marks, space, hyphen, underscore, apostrophe and period. Presets: Hermes
(default) and Jarbas. No "Jarvis" preset: it is a third party's trademark. The choice is kept in the plugin's Desktop storage and
sent to the backend (`POST /assistant`, memory only) on start and on every reconnect. `pre_llm_call` returns one fixed sentence
with the clean name quoted. Nothing writes the persona file (`SOUL.md`) or calls `profiles.configure`; tests scan for both. The
UI shows the name in the page header, in the graph center and in the pane. Language: Auto follows the Hermes Desktop locale, then
the browser language; EN and PT-BR only. The assistant answers in the language the person spoke (the same context line).

## Safety rules (non-negotiable)

- Never auto-approve, never disable guards, never answer an approval without a real user click (`event.detail > 0`), never by
  voice, timer or tool. Destructive commands never get an "always" button.
- Unknown or unparsable command = treated as risky.
- Never read `auth.json`, `.env`, Claude or Codex credential files. Session discovery reads logs only through Hermes.
- Session titles, excerpts, agent goals, profile replies are untrusted: strip control, bidi and tag characters, cap length,
  render as text, label as data when returned to the model.
- `reactor_continue_session` and `reactor_ask_profile` act only after a click on a card; the model gets a label and nothing that
  can trigger anything. Proposals live in server memory only, 5 minutes, single use.
- `reactor_continue_session` details: `ref` must resolve to a session from a fresh listing; the session id matches a strict
  pattern; the folder exists; a session modified less than 2 minutes ago is refused (`active_elsewhere`); no text is interpolated
  into a shell string; execution is an argument list with `shell=False`, the instruction on stdin, cwd = the session folder, an
  environment allowlist, a 20 minute timeout with cancel, bounded output, the process tree stopped on cancel and timeout. Never
  `--dangerously-skip-permissions`, `--yolo`, `--full-auto` or similar. Run consumes the proposal first and re-validates (folder
  identity so a junction swap is refused).
- No telemetry, no network calls of its own, no daemon, no self-updates, no compiled binaries, no secrets stored. The only
  program the plugin starts is the user's `claude` or `codex` (and `taskkill` on Windows), after a click, by `runner.py`.
- Logs and plugin data never store command text, instructions, ask messages or output; counts and codes only.
- Kanban is read only: the observers forward ids and a state; the plugin imports no Kanban module and opens no board file.

## Bilingual

UI strings in `en` and `pt-BR`, following Hermes locale, falling back to `en`. Persona answers in the user's language.

## Done means

- `hermes plugins validate . --install-deps` passes on v0.23.0; each warning listed and justified in README.
- Unit tests green. Real Desktop run with event evidence and screenshots.
- `requires_hermes: ">=0.23.0"`.
- Nothing is published without the author's approval.

## Isolation for every Hermes command

```
HERMES_HOME=<lab>\home
HERMES_GATEWAY_LOCK_DIR=<lab>\locks
```
Python venv: a lab venv that has Hermes installed. The host lock lives outside HERMES_HOME, so omitting the lock dir would
attach to a gateway that is already running for real.

## Continue flow: who may call the backend (verified in the Hermes 0.23.0 source)

`dashboard/plugin_api.py` is imported by the dashboard plugin mount (`hermes_cli/web_server_dashboard.py:1233`) inside the Hermes
process, next to the tools, as a different module object; shared state therefore sits on anchors in `sys.modules`, and the tools
refuse (`ui_unavailable`) when the router was not loaded in their process (plugin host, compute-host child).

Authentication of `/api/plugins/*`: the gateway-hosted listener a local Desktop uses withholds the session token
(`gateway/run_api.py:86`) and accepts a single-use 30 s ticket minted over an owner-only same-user pipe, then sets
`request.state.native_http_principal` (`hermes_cli/dashboard_auth/native_http.py:287-311`). `hermes dashboard` and headless
`hermes serve` print the session token into `GET /` (`hermes_cli/web_server_dashboard.py:141,196`), so there any local process
can authenticate. Therefore every route requires the native principal with `http:owner` and returns 403 `native_only`
otherwise (fail closed). Under `plugins.isolation: host` and for remote Desktops the routes are unusable by design. The server
cannot see the DOM: the real-click rule is enforced in Desktop code, everything else on the server.
