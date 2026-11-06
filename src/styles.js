// All CSS for the plugin, injected from JS as one <style> element (see index.js).
// Colours come from Hermes theme variables (--ui-*) so the reactor re-skins with every
// theme. Selectors only match classes and attributes this plugin renders itself.
// Every animation is switched off under prefers-reduced-motion, and each reactor state
// keeps a distinct still shape there.

export const CSS = `
/* ---------- tint per state (shared by the reactor, the page and the status chip) ---------- */
.jh-tint { --jh-c: var(--ui-accent, currentColor); --jh-glow: color-mix(in srgb, var(--jh-c) 55%, transparent); --jh-ink: color-mix(in srgb, var(--jh-c) 80%, var(--ui-text-primary, currentColor)); }
.jh-tint[data-state='idle'] { --jh-c: var(--ui-accent, currentColor); }
.jh-tint[data-state='listening'] { --jh-c: var(--ui-cyan, var(--ui-accent, currentColor)); }
.jh-tint[data-state='transcribing'] { --jh-c: var(--ui-purple, var(--ui-accent, currentColor)); }
.jh-tint[data-state='thinking'] { --jh-c: color-mix(in srgb, var(--ui-blue, var(--ui-accent)) 55%, var(--ui-accent, currentColor)); }
.jh-tint[data-state='responding'] { --jh-c: var(--ui-green, var(--ui-accent, currentColor)); }
.jh-tint[data-state='approval'] { --jh-c: var(--ui-yellow, var(--ui-orange, var(--ui-accent, currentColor))); }
.jh-tint[data-state='error'] { --jh-c: var(--ui-red, var(--ui-danger, currentColor)); }
.jh-tint[data-state='offline'] { --jh-c: var(--ui-text-quaternary, currentColor); }

/* ---------- the reactor ---------- */
.jh-reactor { position: relative; display: inline-block; color: var(--jh-c); }
.jh-reactor { --jh-c: var(--ui-accent, currentColor); --jh-glow: color-mix(in srgb, var(--jh-c) 55%, transparent); --jh-ink: color-mix(in srgb, var(--jh-c) 80%, var(--ui-text-primary, currentColor)); }
.jh-reactor[data-state='idle'] { --jh-c: var(--ui-accent, currentColor); }
.jh-reactor[data-state='listening'] { --jh-c: var(--ui-cyan, var(--ui-accent, currentColor)); }
.jh-reactor[data-state='transcribing'] { --jh-c: var(--ui-purple, var(--ui-accent, currentColor)); }
.jh-reactor[data-state='thinking'] { --jh-c: color-mix(in srgb, var(--ui-blue, var(--ui-accent)) 55%, var(--ui-accent, currentColor)); }
.jh-reactor[data-state='responding'] { --jh-c: var(--ui-green, var(--ui-accent, currentColor)); }
.jh-reactor[data-state='approval'] { --jh-c: var(--ui-yellow, var(--ui-orange, var(--ui-accent, currentColor))); }
.jh-reactor[data-state='error'] { --jh-c: var(--ui-red, var(--ui-danger, currentColor)); }
.jh-reactor[data-state='offline'] { --jh-c: var(--ui-text-quaternary, currentColor); }

/* ---------- control-room palette ----------
   The reactor is always drawn in the same colours, whatever the Hermes theme is: luminous cyan for the working states,
   amber for an approval, red for an error. They are explicit values on purpose (the theme variables are not
   dark-safe: on a light theme a pale accent vanishes). The stage page is also always dark (see .jh-dark below); the
   small reactors sit on a navy disc so they read on a light theme too. */
.jh-root, .jh-tint, .jh-reactor { --jh-p-idle: #22d3ee; --jh-p-listening: #67e8f9; --jh-p-transcribing: #a78bfa; --jh-p-thinking: #38bdf8; --jh-p-responding: #2dd4bf; --jh-p-approval: #fbbf24; --jh-p-error: #f87171; --jh-p-offline: #64748b; --jh-navy: #060d1f; }
.jh-tint[data-state='idle'], .jh-reactor[data-state='idle'] { --jh-c: var(--jh-p-idle); }
.jh-tint[data-state='listening'], .jh-reactor[data-state='listening'] { --jh-c: var(--jh-p-listening); }
.jh-tint[data-state='transcribing'], .jh-reactor[data-state='transcribing'] { --jh-c: var(--jh-p-transcribing); }
.jh-tint[data-state='thinking'], .jh-reactor[data-state='thinking'] { --jh-c: var(--jh-p-thinking); }
.jh-tint[data-state='responding'], .jh-reactor[data-state='responding'] { --jh-c: var(--jh-p-responding); }
.jh-tint[data-state='approval'], .jh-reactor[data-state='approval'] { --jh-c: var(--jh-p-approval); }
.jh-tint[data-state='error'], .jh-reactor[data-state='error'] { --jh-c: var(--jh-p-error); }
.jh-tint[data-state='offline'], .jh-reactor[data-state='offline'] { --jh-c: var(--jh-p-offline); }
.jh-reactor { --jh-ink: color-mix(in srgb, var(--jh-c) 88%, white); }
.jh-glyph rect, .jh-glyph circle { fill: var(--jh-navy); }
.jh-mini { background: var(--jh-navy); border-radius: 50%; box-shadow: 0 0 0 3px var(--jh-navy); }
.jh-pane-head .jh-stage { background: var(--jh-navy); border-radius: 50%; box-shadow: 0 0 0 5px var(--jh-navy); }

/* The stage page: deep navy control room, always, with the text, stroke and accent variables set to dark-safe values
   so the side panels (agents, activity, approval and proposal cards) stay readable on any Hermes theme. */
.jh-dark { color-scheme: dark; background-color: var(--jh-navy);
  --ui-text-primary: #e8f1ff; --ui-text-secondary: #b9cbe8; --ui-text-tertiary: #93a8cc; --ui-text-quaternary: #7f95bb;
  --ui-stroke-secondary: #2c4170; --ui-stroke-tertiary: #1f3059; --ui-bg-elevated: #0b1630; --ui-bg-editor: #060d1f;
  --chrome-action-hover: rgba(125, 170, 255, 0.14);
  --ui-accent: #22d3ee; --ui-cyan: #22d3ee; --ui-blue: #38bdf8; --ui-green: #34d399; --ui-yellow: #fbbf24; --ui-orange: #fb923c; --ui-red: #f87171; --ui-danger: #f87171; --ui-purple: #a78bfa; }
.jh-dark.jh-page { background-image: radial-gradient(ellipse 70% 55% at 32% 36%, color-mix(in srgb, var(--jh-c) 14%, transparent), transparent 70%), linear-gradient(180deg, #08142e 0%, #060d1f 60%); }
.jh-dark .jh-halo { opacity: 0.7; }

.jh-stage { --jh-size: clamp(200px, 44vmin, 420px); display: block; width: var(--jh-size); height: var(--jh-size); animation: jh-arrive 0.6s cubic-bezier(0.2, 0.8, 0.2, 1) both; }
.jh-stage svg { position: relative; display: block; width: 100%; height: 100%; overflow: visible; filter: drop-shadow(0 0 6px var(--jh-glow)); transition: opacity 0.5s ease; }
.jh-halo { position: absolute; inset: -26%; border-radius: 50%; pointer-events: none; opacity: 0.55; transition: opacity 0.5s ease, background 0.5s ease;
  background: radial-gradient(circle, color-mix(in srgb, var(--jh-c) 30%, transparent) 0%, color-mix(in srgb, var(--jh-c) 11%, transparent) 40%, transparent 68%); }

.jh-stage svg circle, .jh-stage svg polygon { vector-effect: none; }
.jh-stage .jh-turn, .jh-stage .jh-ripple, .jh-stage .jh-core, .jh-stage .jh-ring { transform-origin: 120px 120px; transform-box: view-box; }

.jh-tick { stroke: var(--jh-ink); stroke-width: 7; stroke-dasharray: 1.8 8.2; opacity: 0.8; transition: stroke 0.5s ease; }
.jh-arc { stroke: var(--jh-ink); stroke-width: 2.4; stroke-linecap: round; stroke-dasharray: 78 42; opacity: 0.85; transition: stroke 0.5s ease; }
.jh-track { stroke: var(--jh-ink); stroke-width: 0.8; opacity: 0.4; }
.jh-comet { stroke: var(--jh-ink); stroke-linecap: round; opacity: 0; }
.jh-comet-head { stroke-width: 3.6; stroke-dasharray: 12 348; }
.jh-comet-mid { stroke-width: 2.8; stroke-dasharray: 22 338; stroke-dashoffset: 22; }
.jh-comet-tail { stroke-width: 1.8; stroke-dasharray: 62 298; stroke-dashoffset: 84; }
.jh-bandring { stroke: var(--jh-ink); stroke-width: 6; stroke-dasharray: 2.2 2.2; opacity: 0; }
.jh-ring { stroke: var(--jh-ink); stroke-width: 4.2; stroke-linecap: butt; stroke-dasharray: 360 0; transition: stroke 0.5s ease; }
.jh-dash { stroke: var(--jh-ink); stroke-width: 2.4; stroke-dasharray: 7 3; opacity: 0.6; }
.jh-hexline { stroke: var(--jh-ink); stroke-width: 1.3; stroke-linejoin: round; opacity: 0.7; }
.jh-corering { stroke: var(--jh-ink); stroke-width: 1.4; opacity: 0.8; }
.jh-core { filter: drop-shadow(0 0 5px var(--jh-glow)); }
.jh-stop-hot { stop-color: color-mix(in srgb, var(--jh-c) 35%, white); }
.jh-stop-mid { stop-color: var(--jh-c); }
.jh-stop-edge { stop-color: color-mix(in srgb, var(--jh-c) 60%, transparent); }
.jh-ripple { stroke: var(--jh-ink); stroke-width: 1.5; opacity: 0; }
.jh-glyph { opacity: 0; fill: var(--jh-ink); transition: opacity 0.3s ease; }
.jh-glyph rect, .jh-glyph circle { fill: color-mix(in srgb, var(--ui-bg-editor, black) 80%, var(--jh-c)); }

/* always turning, slowly */
.jh-stage { --t-ticks: 120s; --t-arcs: 70s; --t-inner: 50s; --t-hex: 80s; --t-scan: 2s; --t-core: 5s; }
.jh-ticks { animation: jh-spin var(--t-ticks) linear infinite; }
.jh-arcs { animation: jh-spin-rev var(--t-arcs) linear infinite; }
.jh-inner { animation: jh-spin var(--t-inner) linear infinite; }
.jh-hex { animation: jh-spin-rev var(--t-hex) linear infinite; }
.jh-scan { animation: jh-spin var(--t-scan) linear infinite; }
.jh-band { animation: jh-spin var(--t-band, 6s) linear infinite; }
.jh-core { animation: jh-breathe var(--t-core) ease-in-out infinite; }

/* idle: dim and slow */
.jh-stage[data-state='idle'] svg { opacity: 0.7; }
.jh-stage[data-state='idle'] .jh-halo { opacity: 0.32; }

/* listening: the core beats and rings close in on it */
.jh-stage[data-state='listening'] { --t-ticks: 50s; --t-arcs: 22s; --t-core: 0.95s; }
.jh-stage[data-state='listening'] .jh-core { animation-name: jh-beat; }
.jh-stage[data-state='listening'] .jh-ring { animation: jh-ring-breathe 1.9s ease-in-out infinite; }
.jh-stage[data-state='listening'] .jh-halo { animation: jh-halo 1.9s ease-in-out infinite; }
.jh-stage[data-state='listening'] .jh-ripple { animation: jh-in 2.7s cubic-bezier(0.3, 0.6, 0.4, 1) infinite; }
.jh-stage[data-state='listening'] .jh-rp2 { animation-delay: 0.9s; }
.jh-stage[data-state='listening'] .jh-rp3 { animation-delay: 1.8s; }

/* transcribing: a fine band races round the ring, the arcs counter-turn */
.jh-stage[data-state='transcribing'] { --t-ticks: 30s; --t-arcs: 9s; --t-inner: 6s; --t-band: 3.2s; --t-core: 1.3s; }
.jh-stage[data-state='transcribing'] .jh-bandring { opacity: 0.95; }
.jh-stage[data-state='transcribing'] .jh-ring { --flow: -24; stroke-dasharray: 20 4; animation: jh-flow 2.2s linear infinite; }

/* thinking: the comet sweeps the track, everything counter-rotates fast */
.jh-stage[data-state='thinking'] { --t-ticks: 16s; --t-arcs: 3.8s; --t-inner: 5s; --t-hex: 7s; --t-scan: 1.5s; --t-core: 1.15s; }
.jh-stage[data-state='thinking'] .jh-comet { opacity: 1; }
.jh-stage[data-state='thinking'] .jh-comet-mid { opacity: 0.6; }
.jh-stage[data-state='thinking'] .jh-comet-tail { opacity: 0.3; }
.jh-stage[data-state='thinking'] .jh-track { opacity: 0.7; }

/* responding: the ring flows clockwise and the answer radiates outward */
.jh-stage[data-state='responding'] { --t-ticks: 60s; --t-arcs: 14s; --t-core: 1.1s; }
.jh-stage[data-state='responding'] .jh-ring { stroke-dasharray: 26 7; animation: jh-flow 1.5s linear infinite; }
.jh-stage[data-state='responding'] .jh-ripple { animation: jh-out 3s ease-out infinite; }
.jh-stage[data-state='responding'] .jh-rp2 { animation-delay: 1s; }
.jh-stage[data-state='responding'] .jh-rp3 { animation-delay: 2s; }

/* approval: halted. The ring becomes six gates, the turning stops, the core shows a pause */
.jh-stage[data-state='approval'] .jh-ring { stroke-dasharray: 48 12; stroke-width: 5; animation: jh-gate 1.8s ease-in-out infinite; }
.jh-stage[data-state='approval'] .jh-turn { animation-play-state: paused; }
.jh-stage[data-state='approval'] .jh-hexline { animation: jh-gate 1.8s ease-in-out infinite; stroke-width: 1.8; opacity: 1; }
.jh-stage[data-state='approval'] .jh-core { animation: jh-gate 1.8s ease-in-out infinite; }
.jh-stage[data-state='approval'] .jh-halo { animation: jh-halo 1.8s ease-in-out infinite; opacity: 0.85; }
.jh-stage[data-state='approval'] .jh-glyph-pause { opacity: 1; }

/* error: the ring is broken, the turning stops, a bang sits in the core. Red. */
.jh-stage[data-state='error'] .jh-ring { stroke-dasharray: 118 10 52 22 96 62; stroke-width: 4.6; animation: jh-glitch 1.7s steps(1, end) infinite; }
.jh-stage[data-state='error'] .jh-turn { animation-play-state: paused; }
.jh-stage[data-state='error'] .jh-arc { stroke-dasharray: 40 30 18 60; }
.jh-stage[data-state='error'] .jh-core { animation: jh-breathe 1.7s ease-in-out infinite; }
.jh-stage[data-state='error'] .jh-halo { opacity: 0.8; }
.jh-stage[data-state='error'] .jh-glyph-error { opacity: 1; }

/* offline: cold and still */
.jh-stage[data-state='offline'] svg { opacity: 0.4; filter: none; }
.jh-stage[data-state='offline'] .jh-halo { opacity: 0.06; }
.jh-stage[data-state='offline'] .jh-turn, .jh-stage[data-state='offline'] .jh-core { animation: none; }
.jh-stage[data-state='offline'] .jh-ring { stroke-dasharray: 2 7; stroke-linecap: round; }

@keyframes jh-spin { to { transform: rotate(360deg); } }
@keyframes jh-spin-rev { to { transform: rotate(-360deg); } }
@keyframes jh-arrive { from { opacity: 0; transform: scale(0.82); } }
@keyframes jh-breathe { 0%, 100% { transform: scale(1); opacity: 0.92; } 50% { transform: scale(1.1); opacity: 1; } }
@keyframes jh-beat { 0%, 100% { transform: scale(1); } 18% { transform: scale(1.22); } 36% { transform: scale(1.02); } 54% { transform: scale(1.14); } }
@keyframes jh-ring-breathe { 0%, 100% { transform: scale(1); stroke-width: 4.2; } 50% { transform: scale(1.04); stroke-width: 5.2; } }
@keyframes jh-halo { 0%, 100% { opacity: 0.4; transform: scale(0.96); } 50% { opacity: 0.85; transform: scale(1.04); } }
@keyframes jh-in { 0% { transform: scale(1.18); opacity: 0; } 25% { opacity: 0.75; } 100% { transform: scale(0.6); opacity: 0; } }
@keyframes jh-out { 0% { transform: scale(0.66); opacity: 0.8; } 100% { transform: scale(1.22); opacity: 0; } }
@keyframes jh-flow { to { stroke-dashoffset: var(--flow, -33); } }
@keyframes jh-gate { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
@keyframes jh-glitch { 0% { opacity: 1; } 12% { opacity: 0.35; } 18% { opacity: 1; } 55% { opacity: 1; } 60% { opacity: 0.2; } 64% { opacity: 0.9; } 100% { opacity: 1; } }

/* stills for reduced motion: each state still reads differently */
@media (prefers-reduced-motion: reduce) {
  .jh-stage, .jh-stage *, .jh-mini, .jh-mini * { animation: none !important; transition: none !important; }
  .jh-stage[data-state='listening'] .jh-rp1 { transform: scale(1); opacity: 0.55; }
  .jh-stage[data-state='listening'] .jh-rp2 { transform: scale(0.84); opacity: 0.38; }
  .jh-stage[data-state='listening'] .jh-rp3 { transform: scale(0.68); opacity: 0.22; }
  .jh-stage[data-state='responding'] .jh-rp1 { transform: scale(0.72); opacity: 0.6; }
  .jh-stage[data-state='responding'] .jh-rp2 { transform: scale(0.9); opacity: 0.4; }
  .jh-stage[data-state='responding'] .jh-rp3 { transform: scale(1.08); opacity: 0.22; }
  .jh-stage[data-state='thinking'] .jh-scan { transform: rotate(-90deg); }
  .jh-stage[data-state='approval'] .jh-ring, .jh-stage[data-state='approval'] .jh-hexline { opacity: 1; }
  .jh-stage[data-state='error'] .jh-ring { opacity: 1; }
}

/* ---------- the small reactor (status bar, pane header) ---------- */
.jh-mini { display: inline-flex; flex: none; vertical-align: middle; }
.jh-mini svg { display: block; overflow: visible; }
.jh-m-ring { stroke: var(--jh-ink); stroke-width: 1.8; opacity: 0.55; transform-origin: 12px 12px; }
.jh-m-arc { stroke: var(--jh-ink); stroke-width: 2.4; stroke-linecap: round; stroke-dasharray: 70 290; opacity: 0; }
.jh-m-spin { transform-origin: 12px 12px; transform-box: view-box; }
.jh-m-core { fill: var(--jh-ink); opacity: 0.8; transform-origin: 12px 12px; transform-box: view-box; }
.jh-mini[data-state='idle'] .jh-m-core { animation: jh-breathe 5s ease-in-out infinite; opacity: 0.55; }
.jh-mini[data-state='listening'] .jh-m-core { animation: jh-beat 0.95s ease-in-out infinite; opacity: 1; }
.jh-mini[data-state='listening'] .jh-m-ring { opacity: 1; animation: jh-ring-breathe 1.9s ease-in-out infinite; transform-box: view-box; }
.jh-mini[data-state='transcribing'] .jh-m-ring { stroke-dasharray: 3 3; opacity: 1; }
.jh-mini[data-state='transcribing'] .jh-m-spin { animation: jh-spin 1.2s linear infinite; }
.jh-mini[data-state='transcribing'] .jh-m-arc { opacity: 1; stroke-dasharray: 30 330; }
.jh-mini[data-state='thinking'] .jh-m-spin { animation: jh-spin 1.1s linear infinite; }
.jh-mini[data-state='thinking'] .jh-m-arc { opacity: 1; }
.jh-mini[data-state='thinking'] .jh-m-core { animation: jh-breathe 1.15s ease-in-out infinite; opacity: 1; }
.jh-mini[data-state='responding'] .jh-m-spin { animation: jh-spin 2.6s linear infinite; }
.jh-mini[data-state='responding'] .jh-m-arc { opacity: 1; stroke-dasharray: 150 210; }
.jh-mini[data-state='responding'] .jh-m-core { animation: jh-breathe 1.1s ease-in-out infinite; opacity: 1; }
.jh-mini[data-state='approval'] .jh-m-ring { stroke-dasharray: 48 12; opacity: 1; animation: jh-gate 1.8s ease-in-out infinite; }
.jh-mini[data-state='approval'] .jh-m-core { animation: jh-gate 1.8s ease-in-out infinite; opacity: 1; }
.jh-mini[data-state='error'] .jh-m-ring { stroke-dasharray: 118 10 52 22 96 62; opacity: 1; }
.jh-mini[data-state='error'] .jh-m-core { opacity: 1; animation: jh-glitch 1.7s steps(1, end) infinite; }
.jh-mini[data-state='offline'] .jh-m-core { opacity: 0.35; }
.jh-mini[data-state='offline'] .jh-m-ring { stroke-dasharray: 2 7; stroke-linecap: round; }

/* ---------- shared bits ---------- */
.jh-root { color: var(--ui-text-primary); font-size: 13px; line-height: 1.45; box-sizing: border-box; }
.jh-root *, .jh-root *::before, .jh-root *::after { box-sizing: border-box; }
.jh-root button { font: inherit; color: inherit; }
.jh-root :focus-visible { outline: 2px solid var(--ui-accent, currentColor); outline-offset: 2px; border-radius: 4px; }
.jh-muted { color: var(--ui-text-tertiary); }
.jh-faint { color: var(--ui-text-quaternary); }
.jh-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.jh-chip { display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px; border-radius: 999px; font-size: 11px; line-height: 18px; color: var(--ui-text-secondary); border: 1px solid var(--ui-stroke-secondary); background: transparent; }
.jh-chip[data-on='true'] { color: var(--jh-c); border-color: color-mix(in srgb, var(--jh-c) 45%, transparent); }
.jh-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--jh-c); flex: none; }
.jh-btn { cursor: pointer; border: 1px solid var(--ui-stroke-secondary); background: transparent; color: var(--ui-text-primary); border-radius: 8px; padding: 6px 12px; transition: background 0.15s ease, border-color 0.15s ease; }
.jh-btn:hover:not(:disabled) { background: var(--chrome-action-hover, color-mix(in srgb, currentColor 8%, transparent)); }
.jh-btn:disabled { cursor: default; opacity: 0.5; }
.jh-btn-sm { padding: 3px 9px; font-size: 12px; border-radius: 6px; }

/* ---------- the stage page ---------- */
.jh-page { container-type: inline-size; container-name: jhpage; position: relative; height: 100%; min-height: 0; overflow: hidden; padding: 14px 22px 16px; display: flex; flex-direction: column; gap: 10px;
  background: radial-gradient(ellipse 70% 55% at 32% 36%, color-mix(in srgb, var(--jh-c) 9%, transparent), transparent 70%); transition: background 0.6s ease; }
.jh-page-head { flex: none; display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 10px; }
.jh-brand { font-size: 12px; font-weight: 600; letter-spacing: 0.32em; text-transform: uppercase; color: var(--ui-text-secondary); }
.jh-seg { display: inline-flex; border: 1px solid var(--ui-stroke-secondary); border-radius: 999px; overflow: hidden; }
.jh-seg button { border: 0; background: transparent; padding: 2px 10px; font-size: 11px; cursor: pointer; color: var(--ui-text-tertiary); }
.jh-seg button[aria-pressed='true'] { color: var(--ui-text-primary); background: var(--chrome-action-hover, color-mix(in srgb, currentColor 10%, transparent)); }
.jh-page-body { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(300px, 1fr); gap: 28px; align-items: start; flex: 1; min-height: 0; }
@media (max-width: 880px) { .jh-page-body { grid-template-columns: minmax(0, 1fr); } }
.jh-hero { display: flex; flex-direction: column; align-items: center; gap: 18px; padding-top: 14px; }
.jh-caption { text-align: center; min-height: 92px; max-width: 520px; }
.jh-state-label { margin: 0; font-size: clamp(15px, 1.9vw, 22px); font-weight: 600; letter-spacing: 0.3em; text-transform: uppercase; color: var(--jh-ink); text-shadow: 0 0 18px var(--jh-glow); transition: color 0.4s ease; }
.jh-state-hint { margin: 6px 0 0; color: var(--ui-text-tertiary); }
.jh-heard { margin: 12px auto 0; max-width: 460px; padding: 6px 12px; border-left: 2px solid var(--jh-c); color: var(--ui-text-secondary); font-style: italic; text-align: left; overflow-wrap: anywhere; animation: jh-fade 0.3s ease both; }
.jh-heard[data-final='false'] { opacity: 0.75; }
.jh-heard-label { display: block; font-style: normal; font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--ui-text-quaternary); }
@keyframes jh-fade { from { opacity: 0; transform: translateY(4px); } }
.jh-note { font-size: 11px; color: var(--ui-text-quaternary); text-align: center; max-width: 420px; }
.jh-side { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
.jh-section-title { margin: 0 0 8px; font-size: 11px; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase; color: var(--ui-text-tertiary); display: flex; align-items: center; gap: 8px; }
.jh-feed { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.jh-feed li { display: flex; align-items: baseline; gap: 10px; color: var(--ui-text-secondary); font-size: 12px; }
.jh-feed time { color: var(--ui-text-quaternary); font-variant-numeric: tabular-nums; font-size: 11px; min-width: 52px; }
.jh-feed li[data-kind='error'] { color: var(--ui-red, var(--ui-danger, inherit)); }
.jh-preview { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.jh-preview details { width: 100%; }
.jh-preview summary { cursor: pointer; color: var(--ui-text-tertiary); font-size: 11px; }

/* ---------- approval card ---------- */
.jh-approvals { display: flex; flex-direction: column; gap: 12px; }
.jh-approval { --jh-c: var(--ui-yellow, var(--ui-orange, var(--ui-accent, currentColor)));
  position: relative; border: 1px solid color-mix(in srgb, var(--jh-c) 55%, var(--ui-stroke-secondary)); border-radius: 12px; padding: 14px 16px 14px;
  background: color-mix(in srgb, var(--jh-c) 7%, var(--ui-bg-elevated, transparent)); box-shadow: 0 0 0 1px color-mix(in srgb, var(--jh-c) 12%, transparent), 0 8px 30px color-mix(in srgb, var(--jh-c) 14%, transparent); animation: jh-fade 0.25s ease both; }
.jh-approval[data-level='destructive'] { --jh-c: var(--ui-red, var(--ui-danger, currentColor)); }
.jh-approval[data-level='safe'] { --jh-c: var(--ui-green, var(--ui-accent, currentColor)); }
.jh-approval-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.jh-approval-title { margin: 0; font-size: 14px; font-weight: 600; }
.jh-risk { margin-left: auto; padding: 1px 9px; border-radius: 999px; font-size: 11px; color: var(--jh-c); border: 1px solid color-mix(in srgb, var(--jh-c) 50%, transparent); white-space: nowrap; }
.jh-approval h4 { margin: 10px 0 4px; font-size: 10.5px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ui-text-tertiary); }
.jh-code { margin: 0; padding: 8px 10px; border-radius: 8px; max-height: 190px; overflow: auto; font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere;
  background: color-mix(in srgb, var(--ui-text-primary) 6%, transparent); border: 1px solid var(--ui-stroke-tertiary, var(--ui-stroke-secondary)); }
.jh-approval ul { margin: 0; padding-left: 18px; color: var(--ui-text-secondary); }
.jh-approval p { margin: 0; color: var(--ui-text-secondary); overflow-wrap: anywhere; }
.jh-approval-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
/* Explicit colours, not theme variables (and .jh-root in front: the rule .jh-root button { color: inherit } is more specific than a bare
   class, which is how the dark label on blue happened in the first place): white on #1e40af is 8.7:1 and white on #1d4ed8 is 6.7:1, on any theme.
   The disabled look keeps the colours (it only lowers the opacity) so a button never turns into pale text on blue. */
.jh-root .jh-btn-deny { background: #1e40af; border-color: #93c5fd; color: #ffffff; font-weight: 600; }
.jh-root .jh-btn-deny:hover:not(:disabled) { background: #1d4ed8; }
.jh-root .jh-btn-deny:disabled { opacity: 0.65; }
.jh-approval-actions .jh-btn-allow { color: var(--ui-text-primary); }
.jh-btn-expand { margin-top: 8px; border-color: color-mix(in srgb, var(--jh-c) 70%, transparent); }
.jh-approval-status[data-tone='warn'] { color: var(--ui-text-primary); border-left: 3px solid var(--jh-c); padding: 6px 10px; background: color-mix(in srgb, var(--jh-c) 12%, transparent); border-radius: 0 8px 8px 0; }
.jh-code-full { max-height: 340px; resize: vertical; }
.jh-pr-trust { margin-top: 8px; font-size: 12px; }
.jh-approval[data-level='destructive'] .jh-btn-allow { border-color: color-mix(in srgb, var(--jh-c) 55%, transparent); }
.jh-approval-status { margin-top: 10px; font-size: 12px; color: var(--ui-text-secondary); }
.jh-approval-status[data-tone='error'] { color: var(--ui-red, var(--ui-danger, inherit)); }
.jh-approval-hint { margin-top: 8px; font-size: 11px; color: var(--ui-text-quaternary); }

/* ---------- continue-session proposal card ---------- */
.jh-proposal { padding: 18px 20px 16px; border-width: 2px; }
.jh-proposal[data-status='finished'] { --jh-c: var(--ui-green, var(--ui-accent, currentColor)); }
.jh-proposal[data-status='failed'] { --jh-c: var(--ui-red, var(--ui-danger, currentColor)); }
.jh-proposal[data-status='expired'], .jh-proposal[data-status='denied'], .jh-proposal[data-status='cancelled'] { --jh-c: var(--ui-text-tertiary, currentColor); background: transparent; box-shadow: none; }
.jh-pr-title { font-size: 16px; }
.jh-pr-field h4 { margin: 12px 0 4px; }
.jh-pr-agent { font-weight: 600; color: var(--ui-text-primary); }
.jh-pr-instruction { max-height: 240px; font-size: 13px; }
.jh-pr-folder { max-height: 64px; }
.jh-pr-output { max-height: 260px; }
.jh-pr-perm { margin-top: 12px; font-size: 12px; }
.jh-pr-note { margin: 8px 0 0; font-size: 11px; }
.jh-btn-big { padding: 10px 22px; font-size: 14px; border-radius: 10px; min-width: 96px; }

/* ---------- agents ---------- */
.jh-agents { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.jh-agents-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.jh-input { flex: 1; min-width: 120px; border: 1px solid var(--ui-stroke-secondary); border-radius: 8px; background: transparent; color: var(--ui-text-primary); padding: 5px 9px; font: inherit; }
.jh-input::placeholder { color: var(--ui-text-quaternary); }
.jh-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.jh-row { display: block; width: 100%; text-align: left; cursor: pointer; border: 1px solid var(--ui-stroke-tertiary, var(--ui-stroke-secondary)); background: transparent; border-radius: 10px; padding: 9px 11px; transition: background 0.15s ease, border-color 0.15s ease; }
.jh-row:hover { background: var(--chrome-action-hover, color-mix(in srgb, currentColor 8%, transparent)); border-color: var(--ui-stroke-secondary); }
.jh-row-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.jh-agent { flex: none; font-size: 10px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; padding: 1px 7px; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--jh-agent, var(--ui-accent)) 50%, transparent); color: var(--jh-agent, var(--ui-accent)); }
.jh-agent[data-source='claude'] { --jh-agent: var(--ui-orange, var(--ui-accent, currentColor)); }
.jh-agent[data-source='codex'] { --jh-agent: var(--ui-cyan, var(--ui-accent, currentColor)); }
.jh-row-title { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.jh-row-meta { margin-top: 3px; display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 11.5px; color: var(--ui-text-tertiary); }
.jh-active { color: var(--ui-yellow, var(--ui-orange, inherit)); }
.jh-state-box { border: 1px dashed var(--ui-stroke-secondary); border-radius: 10px; padding: 16px; text-align: center; color: var(--ui-text-tertiary); display: flex; flex-direction: column; gap: 10px; align-items: center; }
.jh-state-box[data-tone='error'] { color: var(--ui-red, var(--ui-danger, inherit)); border-color: color-mix(in srgb, var(--ui-red, currentColor) 45%, transparent); }
.jh-skel { height: 54px; border-radius: 10px; background: linear-gradient(90deg, color-mix(in srgb, currentColor 5%, transparent), color-mix(in srgb, currentColor 11%, transparent), color-mix(in srgb, currentColor 5%, transparent)); background-size: 200% 100%; animation: jh-shimmer 1.4s ease-in-out infinite; }
@keyframes jh-shimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }
@media (prefers-reduced-motion: reduce) { .jh-skel, .jh-approval, .jh-proposal, .jh-heard, .jh-page { animation: none !important; transition: none !important; } }

/* ---------- pane ---------- */
.jh-pane { height: 100%; min-height: 0; overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 14px; }
.jh-pane-head { display: flex; align-items: center; gap: 10px; cursor: default; }
.jh-pane-head .jh-state-label { font-size: 12px; letter-spacing: 0.2em; flex: 1; }
.jh-linkbtn { border: 0; background: transparent; color: var(--ui-text-tertiary); cursor: pointer; padding: 2px 6px; border-radius: 6px; font-size: 12px; }
.jh-linkbtn:hover { color: var(--ui-text-primary); background: var(--chrome-action-hover, transparent); }

/* ---------- status bar item ---------- */
.jh-status { display: inline-flex; align-items: center; gap: 6px; height: 100%; padding: 0 8px; border: 0; background: transparent; cursor: pointer; color: var(--ui-text-tertiary); font-size: 11px; border-radius: 4px; }
.jh-status:hover { background: var(--chrome-action-hover, transparent); color: var(--ui-text-primary); }
.jh-status[data-state='approval'], .jh-status[data-state='error'] { color: var(--jh-c); }
.jh-badge { min-width: 15px; height: 15px; padding: 0 4px; border-radius: 8px; font-size: 10px; line-height: 15px; text-align: center; background: var(--jh-c); color: #04101f; font-weight: 700; }

/* ---------- chat directive card ---------- */
.jh-card { max-width: 520px; margin: 6px 0; padding: 10px 12px; border: 1px solid var(--ui-stroke-secondary); border-radius: 12px; display: flex; flex-direction: column; gap: 6px; background: var(--ui-bg-elevated, transparent); }
.jh-card-actions { display: flex; gap: 8px; margin-top: 4px; }

/* ---------- live agent graph ---------- */
.jh-graph { position: absolute; inset: 0; display: flex; flex-direction: column; border: 1px solid var(--ui-stroke-tertiary); border-radius: 14px; padding: 10px 12px 12px; background: color-mix(in srgb, var(--jh-navy) 72%, transparent); }
.jh-graph[data-focus='true'] { box-shadow: 0 0 0 2px color-mix(in srgb, var(--jh-p-idle) 55%, transparent); }
.jh-graph-body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(220px, 280px); gap: 12px; }
.jh-graph-canvas { position: relative; min-width: 0; min-height: 0; }
.jh-gsvg { position: absolute; inset: 0; width: 100%; height: 100%; display: block; overflow: visible; }
.jh-gedge { stroke: color-mix(in srgb, #22d3ee 38%, transparent); stroke-width: 1.4; }
.jh-gedge[data-status='running'] { stroke: #38bdf8; stroke-width: 2; stroke-dasharray: 6 5; animation: jh-edge 0.9s linear infinite; }
.jh-gedge[data-status='queued'] { stroke: #fbbf24; stroke-dasharray: 2 6; }
.jh-gedge[data-status='completed'] { stroke: color-mix(in srgb, #34d399 70%, transparent); }
.jh-gedge[data-status='failed'], .jh-gedge[data-status='error'], .jh-gedge[data-status='timeout'] { stroke: #f87171; }
.jh-gedge[data-status='interrupted'] { stroke: #fb923c; }
.jh-gedge[data-status='unknown'] { stroke: #93a8cc; stroke-dasharray: 1 5; }
.jh-gnode { --gc: #22d3ee; cursor: pointer; outline: none; }
.jh-gnode[data-kind='profile'] { --gc: #22d3ee; }
.jh-gnode[data-kind='session'] { --gc: #a78bfa; }
.jh-gnode[data-kind='agent'][data-status='queued'] { --gc: #fbbf24; }
.jh-gnode[data-kind='agent'][data-status='running'] { --gc: #38bdf8; }
.jh-gnode[data-kind='agent'][data-status='completed'] { --gc: #34d399; }
.jh-gnode[data-kind='agent'][data-status='failed'], .jh-gnode[data-kind='agent'][data-status='error'], .jh-gnode[data-kind='agent'][data-status='timeout'] { --gc: #f87171; }
.jh-gnode[data-kind='agent'][data-status='interrupted'] { --gc: #fb923c; }
.jh-gnode[data-kind='agent'][data-status='unknown'] { --gc: #93a8cc; }
.jh-gnode[data-kind='reactor'] { --gc: #22d3ee; }
.jh-gnode[data-state='thinking'] { --gc: #38bdf8; }
.jh-gnode[data-state='responding'] { --gc: #2dd4bf; }
.jh-gnode[data-state='listening'] { --gc: #67e8f9; }
.jh-gnode[data-state='approval'] { --gc: #fbbf24; }
.jh-gnode[data-state='error'] { --gc: #f87171; }
.jh-gnode[data-state='offline'] { --gc: #64748b; }
.jh-gdot { fill: #060d1f; stroke: var(--gc); stroke-width: 2; }
.jh-gnode[data-kind='reactor'] .jh-gdot { fill: color-mix(in srgb, var(--gc) 22%, #060d1f); stroke-width: 3; filter: drop-shadow(0 0 8px var(--gc)); }
.jh-gnode[data-kind='agent'][data-status='running'] .jh-gdot { fill: color-mix(in srgb, var(--gc) 30%, #060d1f); animation: jh-gpulse 1.4s ease-in-out infinite; }
.jh-gnode[data-kind='agent'][data-status='completed'] .jh-gdot { fill: color-mix(in srgb, var(--gc) 26%, #060d1f); }
.jh-gnode[data-kind='agent'][data-status='queued'] .jh-gdot { stroke-dasharray: 3 3; }
.jh-gnode[data-kind='agent'][data-status='unknown'] .jh-gdot { stroke-dasharray: 2 3; }
.jh-gnode[data-lit='true'] .jh-gdot { fill: color-mix(in srgb, var(--gc) 55%, #060d1f); filter: drop-shadow(0 0 12px var(--gc)); animation: jh-gpulse 0.8s ease-in-out infinite; }
.jh-gnode[data-stale='true'] { opacity: 0.5; }
.jh-gring { fill: none; stroke: var(--gc); stroke-width: 1.5; opacity: 0; transition: opacity 0.15s ease; }
.jh-gnode[data-selected='true'] .jh-gring, .jh-gnode:focus-visible .jh-gring { opacity: 1; }
.jh-gnode:hover .jh-gring { opacity: 0.55; }
.jh-glabel { fill: #b9cbe8; font-size: 12px; pointer-events: none; }
.jh-gnode[data-kind='reactor'] .jh-glabel { fill: #e8f1ff; font-size: 13px; font-weight: 600; }
.jh-gglyph { fill: var(--gc); font-size: 14px; font-weight: 700; pointer-events: none; }
.jh-graph-empty { position: absolute; left: 0; right: 0; top: 4px; margin: 0; text-align: center; font-size: 12px; }
.jh-graph-hidden { margin: 4px 0 0; font-size: 11px; }
.jh-graph-detail { min-width: 0; min-height: 0; overflow-y: auto; font-size: 12.5px; padding: 8px 4px 8px 12px; border-left: 1px solid var(--ui-stroke-tertiary); }
@container (max-width: 720px) {
  .jh-graph-body { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) auto; gap: 6px; }
  .jh-graph-detail { max-height: 34cqh; border-left: 0; border-top: 1px solid var(--ui-stroke-tertiary); padding: 6px 4px 0; }
}
.jh-graph-detail[data-open='true'] { border-left-color: var(--ui-stroke-secondary); }
.jh-graph-tip { margin: 6px 0 0; font-size: 11px; text-align: center; }
.jh-gd-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
.jh-gd-kind { font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ui-text-tertiary); }
.jh-gd-title { font-weight: 600; color: var(--ui-text-primary); overflow-wrap: anywhere; margin-right: auto; }
.jh-gd { margin: 0; display: grid; gap: 5px; }
.jh-gd-row { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 8px; }
.jh-gd-row dt { color: var(--ui-text-tertiary); }
.jh-gd-row dd { margin: 0; color: var(--ui-text-primary); overflow-wrap: anywhere; white-space: pre-wrap; }
.jh-gd-note { margin: 8px 0 0; font-size: 11px; }
@keyframes jh-edge { to { stroke-dashoffset: -22; } }
@keyframes jh-gpulse { 50% { stroke-width: 3.4; } }
@media (prefers-reduced-motion: reduce) { .jh-gedge, .jh-gdot { animation: none !important; } }

/* ---------- assistant name, kanban line ---------- */
.jh-name { border: 1px solid var(--ui-stroke-tertiary); border-radius: 10px; padding: 6px 10px; }
.jh-name summary { cursor: pointer; font-size: 12px; color: var(--ui-text-secondary); }
.jh-name-form { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; margin-top: 8px; }
.jh-name-label { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--ui-text-tertiary); flex: 1; min-width: 160px; }
.jh-name .jh-btn[aria-pressed='true'] { border-color: var(--jh-p-idle); color: var(--jh-p-idle); }
.jh-brand-line { margin: 0; font-size: 11px; font-weight: 600; letter-spacing: 0.22em; text-transform: uppercase; color: var(--ui-text-secondary); }
.jh-kanban-line { border: 1px solid var(--ui-stroke-tertiary); border-radius: 10px; padding: 8px 12px; }
.jh-kanban-line p { margin: 0; font-size: 12.5px; }
.jh-kanban-text { color: var(--ui-text-primary); overflow-wrap: anywhere; }
.jh-ask .jh-pr-output { max-height: 220px; }

/* ---------- stage layout: the reactor is the hero; a segmented control picks Reactor | Graph | Agents ---------- */
.jh-head-right { display: flex; justify-content: flex-end; align-items: center; gap: 10px; flex-wrap: wrap; }
.jh-tabs { display: inline-flex; padding: 3px; gap: 2px; border: 1px solid var(--ui-stroke-secondary); border-radius: 999px; background: color-mix(in srgb, var(--jh-navy) 60%, transparent); }
.jh-tabs [role='tab'] { border: 0; background: transparent; padding: 4px 18px; border-radius: 999px; font-size: 12px; cursor: pointer; color: var(--ui-text-secondary); }
.jh-tabs [role='tab']:hover { color: var(--ui-text-primary); }
.jh-root .jh-tabs [role='tab'][aria-selected='true'] { color: #04101f; background: var(--jh-c); font-weight: 600; }
@container jhpage (max-width: 720px) { .jh-page-head { grid-template-columns: auto minmax(0, 1fr); } .jh-page-head .jh-tabs { justify-self: end; } .jh-page-head .jh-head-right { grid-column: 1 / -1; justify-content: flex-start; } }
.jh-stage-cards { flex: none; min-height: 0; max-height: 64%; display: flex; flex-direction: column; gap: 6px; overflow-y: auto; overscroll-behavior: contain; padding-right: 4px; }
.jh-stage-cards > section { flex: none; display: flex; flex-direction: column; }
.jh-stage-cards .jh-section-title { flex: none; margin-bottom: 4px; }
.jh-stage-view { position: relative; flex: 1; min-height: 0; container-type: size; }
.jh-stage-view { --jh-aside: min(330px, 32cqw); }
.jh-stage-layout { position: absolute; inset: 0; display: grid; grid-template-columns: minmax(0, 1fr) var(--jh-aside); gap: 14px; }
.jh-stage-hero { min-width: 0; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; overflow: hidden; }
.jh-stage-hero .jh-reactor.jh-stage { --jh-size: clamp(96px, min(100cqh - 150px, 100cqw - var(--jh-aside) - 60px), 640px); }
.jh-stage-hero .jh-caption { min-height: 0; flex: none; }
.jh-stage-hero .jh-state-label { font-size: clamp(14px, 2.2cqh, 22px); }
.jh-stage-aside { min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; padding: 12px 14px; border-radius: 14px; border: 1px solid var(--ui-stroke-tertiary); background: color-mix(in srgb, var(--jh-navy) 80%, transparent); }
.jh-stage-agents { position: absolute; inset: 0; overflow-y: auto; padding-right: 4px; }
/* A narrow page (the window has side panes open): the reactor takes the whole width and the aside shrinks to its first rows underneath. */
@container (max-width: 820px) {
  .jh-stage-layout { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) auto; gap: 8px; }
  .jh-stage-hero .jh-reactor.jh-stage { --jh-size: clamp(96px, min(100cqh - 250px, 100cqw - 40px), 640px); }
  .jh-stage-aside { max-height: 30cqh; padding: 8px 12px; gap: 8px; }
  .jh-stage-aside .jh-preview, .jh-stage-aside .jh-feed-section { display: none; }
}
@container (max-height: 330px) { .jh-stage-hero .jh-state-hint, .jh-stage-hero .jh-note, .jh-stage-hero .jh-heard { display: none; } }
@media (max-width: 760px) { .jh-page-head { grid-template-columns: minmax(0, 1fr); } .jh-head-right { justify-content: flex-start; } }

/* ---------- the graph view: canvas beside its detail panel, reactor artwork in the Hermes node ---------- */
.jh-gart-box { pointer-events: none; overflow: visible; }
.jh-gart-box .jh-reactor.jh-stage { --jh-size: 100%; animation: none; }
.jh-gnode[data-kind='reactor'] .jh-gdot { fill: color-mix(in srgb, var(--gc) 10%, #060d1f); stroke-width: 2; }

/* ---------- cards: the content scrolls, the action buttons never leave the card ---------- */
.jh-approval { display: flex; flex-direction: column; max-height: min(66vh, 560px); min-height: 0; }
.jh-approval-head { flex: none; }
.jh-approval-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding-right: 2px; overscroll-behavior: contain; }
.jh-approval-statuses { flex: none; max-height: 30%; overflow-y: auto; }
.jh-approval-actions { flex: none; position: sticky; bottom: 0; z-index: 1; margin-top: 10px; padding-top: 10px; border-top: 1px solid color-mix(in srgb, var(--jh-c) 28%, transparent); background: color-mix(in srgb, var(--jh-c) 7%, var(--ui-bg-elevated, var(--jh-navy))); }
.jh-card-scroll { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding-right: 4px; }
.jh-stage-cards .jh-card-scroll, .jh-pane .jh-card-scroll { flex: none; overflow: visible; padding-right: 0; }
.jh-card-scroll > .jh-approval { flex: none; }
.jh-pane .jh-approval { max-height: min(76vh, 560px); }
.jh-ask-banner { margin: 8px 0 0; padding: 8px 10px; border-radius: 8px; font-size: 12.5px; font-weight: 600; border: 1px solid; }
.jh-ask-banner[data-tone='danger'] { color: #04101f; background: #f87171; border-color: #ffffff; }
.jh-ask-banner[data-tone='warn'] { color: var(--ui-text-primary); background: color-mix(in srgb, #fbbf24 22%, transparent); border-color: #fbbf24; }
`
