// Stand-in for @hermes/plugin-sdk, which only exists inside Hermes Desktop.
// Tests that render views import this instead. Nothing here talks to a gateway.
export const host = {
  state: {},
  notify: () => {},
  request: async () => ({}),
  navigate: () => {},
  composer: { insertText: async () => false, focus: () => {} }
}
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar.nav'
export const PANES_AREA = 'panes'
export const STATUSBAR_AREAS = { left: 'statusBar.left', right: 'statusBar.right' }
export const PALETTE_AREA = 'palette'
export const KANBAN_CARD_AREAS = { badges: 'kanban.card.badges' }
export const TRANSCRIPT_DIRECTIVE_AREA = 'transcript.directives'
export const APPROVAL_RESPOND_TIMEOUT_MS = 330000
export const useI18n = () => ({ locale: 'en' })
export const useValue = atom => atom.get()
