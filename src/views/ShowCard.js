// The chat card for `::reactor-show{view="graph"}`. The model writes the directive, so the attribute is untrusted: it must be one
// of the closed list of views. Rendering NEVER navigates; only a click on the button opens the screen.

import { isTrustedGesture } from '../model/approval.js'
import { validateShow } from '../model/screens.js'
import { h } from './h.js'
import { getRuntime, useT } from './hooks.js'

export function ShowCard({ attrs }) {
  const rt = getRuntime()
  const { t } = useT()
  const view = validateShow({ view: attrs && typeof attrs.view === 'string' ? attrs.view : '' })
  if (!view) return h('div', { className: 'jh-root jh-card jh-muted' }, t('show.invalid'))
  return h(
    'div',
    { className: 'jh-root jh-card' },
    h(
      'div',
      { className: 'jh-card-actions' },
      h(
        'button',
        {
          type: 'button',
          className: 'jh-btn jh-btn-sm',
          onClick: event => {
            if (isTrustedGesture(event.nativeEvent)) rt.show.show(view, { byUser: true })
          }
        },
        t('show.open', { view: t(`show.view.${view}`) })
      )
    )
  )
}
