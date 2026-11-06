// The reactor: the plugin's visual centrepiece. Pure SVG and CSS, no canvas, no timers.
// The component only sets `data-state`; every animation lives in styles.js and is turned
// off under prefers-reduced-motion, where each state keeps a distinct still shape.
//
// It follows what Hermes reports. It does not measure audio and shows no level meter.

import { useId } from 'react'

import { h } from './h.js'

const C = 120 // centre of the 240 x 240 drawing

function hexPoints(radius) {
  const pts = []
  for (let i = 0; i < 6; i += 1) {
    const a = (-90 + i * 60) * (Math.PI / 180)
    pts.push(`${(C + radius * Math.cos(a)).toFixed(2)},${(C + radius * Math.sin(a)).toFixed(2)}`)
  }
  return pts.join(' ')
}

const circle = (className, r, extra = {}) =>
  h('circle', { className, cx: C, cy: C, r, fill: 'none', ...extra })

/** Small version for the status bar and the pane header. */
function MiniReactor({ state, size, label }) {
  return h(
    'span',
    { className: 'jh-reactor jh-mini', 'data-state': state, style: { width: size, height: size }, role: 'img', 'aria-label': label },
    h(
      'svg',
      { viewBox: '0 0 24 24', width: size, height: size, focusable: 'false', 'aria-hidden': 'true' },
      h('circle', { className: 'jh-m-ring', cx: 12, cy: 12, r: 9.2, fill: 'none', pathLength: 360 }),
      h('g', { className: 'jh-m-spin' }, h('circle', { className: 'jh-m-arc', cx: 12, cy: 12, r: 9.2, fill: 'none', pathLength: 360 })),
      h('circle', { className: 'jh-m-core', cx: 12, cy: 12, r: 3.6 })
    )
  )
}

/**
 * @param {{ state: string, size?: number | string, detail?: 'stage' | 'mini', label?: string }} props
 *   `size` is a CSS length for the stage (default fills its box); a number of px for the mini one.
 */
export function Reactor({ state, size, detail = 'stage', label = '' }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  if (detail === 'mini') return h(MiniReactor, { state, size: size ?? 18, label })

  const style = size ? { '--jh-size': typeof size === 'number' ? `${size}px` : size } : undefined
  const coreGrad = `jh-cg-${uid}`

  return h(
    'span',
    { className: 'jh-reactor jh-stage', 'data-state': state, style, role: 'img', 'aria-label': label },
    h('span', { className: 'jh-halo', 'aria-hidden': 'true' }),
    h(
      'svg',
      { viewBox: '0 0 240 240', focusable: 'false', 'aria-hidden': 'true' },
      h(
        'defs',
        null,
        h(
          'radialGradient',
          { id: coreGrad, cx: '50%', cy: '50%', r: '50%' },
          h('stop', { offset: '0%', className: 'jh-stop-hot' }),
          h('stop', { offset: '55%', className: 'jh-stop-mid' }),
          h('stop', { offset: '100%', className: 'jh-stop-edge' })
        )
      ),

      // Listening: three rings closing in on the core (hearing). Responding: the same
      // idea flowing outwards. Both are still, offset rings under reduced motion.
      h(
        'g',
        { className: 'jh-ripples' },
        circle('jh-ripple jh-rp1', 96, { pathLength: 360 }),
        circle('jh-ripple jh-rp2', 96, { pathLength: 360 }),
        circle('jh-ripple jh-rp3', 96, { pathLength: 360 })
      ),

      // Outer tick scale, 72 marks, turning slowly.
      h('g', { className: 'jh-turn jh-ticks' }, circle('jh-tick', 114, { pathLength: 720 })),

      // Three long arcs against the grain.
      h('g', { className: 'jh-turn jh-arcs' }, circle('jh-arc', 105, { pathLength: 360 })),

      // Hairline track with the scanner comet (thinking).
      circle('jh-track', 94),
      h(
        'g',
        { className: 'jh-turn jh-scan' },
        circle('jh-comet jh-comet-tail', 94, { pathLength: 360 }),
        circle('jh-comet jh-comet-mid', 94, { pathLength: 360 }),
        circle('jh-comet jh-comet-head', 94, { pathLength: 360 })
      ),

      // Transcribing: a fine segmented band that runs around the ring.
      h('g', { className: 'jh-turn jh-band' }, circle('jh-bandring', 84, { pathLength: 360 })),

      // The main ring. Full normally, gated in six when waiting for approval, broken on error.
      circle('jh-ring', 71, { pathLength: 360 }),

      // Inner dashed ring and a hexagon turning against it.
      h('g', { className: 'jh-turn jh-inner' }, circle('jh-dash', 57, { pathLength: 360 })),
      h('g', { className: 'jh-turn jh-hex' }, h('polygon', { className: 'jh-hexline', points: hexPoints(46), fill: 'none' })),

      // The core, with a glyph for the states that need one.
      circle('jh-corering', 27),
      h('circle', { className: 'jh-core', cx: C, cy: C, r: 16, fill: `url(#${coreGrad})` }),
      h(
        'g',
        { className: 'jh-glyph jh-glyph-pause' },
        h('rect', { x: C - 7, y: C - 8, width: 4.5, height: 16, rx: 1.4 }),
        h('rect', { x: C + 2.5, y: C - 8, width: 4.5, height: 16, rx: 1.4 })
      ),
      h(
        'g',
        { className: 'jh-glyph jh-glyph-error' },
        h('rect', { x: C - 2.3, y: C - 9, width: 4.6, height: 11.5, rx: 1.6 }),
        h('circle', { cx: C, cy: C + 7, r: 2.6 })
      )
    )
  )
}
