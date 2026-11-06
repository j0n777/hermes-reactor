// React hooks over the runtime stores. The runtime is set once by the entry point (or by
// the dev harness) before any view renders.

import { useI18n } from '@hermes/plugin-sdk'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import { createArmGate } from '../model/arming.js'
import { makeT, resolveLocale } from '../model/i18n.js'

let current = null

export function setRuntime(runtime) {
  current = runtime
}

export function getRuntime() {
  if (!current) throw new Error('Reactor runtime is not ready')
  return current
}

function useStore(store) {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}

export function useAppState() {
  return useStore(getRuntime().store)
}

export function useAgentsState() {
  return useStore(getRuntime().agents)
}

export function useProposalsState() {
  return useStore(getRuntime().proposals)
}

export function useGraphState() {
  return useStore(getRuntime().graph)
}

export function useAssistantState() {
  return useStore(getRuntime().assistant)
}

export function useAsksState() {
  return useStore(getRuntime().asks)
}

export function useKanbanState() {
  return useStore(getRuntime().kanban)
}

export function useUiState() {
  return useStore(getRuntime().ui)
}

/**
 * Anti-misclick: false for ARM_MS after the card first shows and again after `signature` (what it says) or its height changes.
 * Server rendering has no effects, so the first draw is always disarmed.
 */
export function useArmed(rootRef, signature) {
  const [armed, setArmed] = useState(false)
  const gate = useRef(null)
  if (gate.current === null) gate.current = createArmGate({ onChange: setArmed })
  useEffect(() => {
    gate.current.touch(signature)
  }, [signature])
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const measure = () => gate.current.layout(el.getBoundingClientRect().height)
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    measure()
    return () => observer.disconnect()
  }, [rootRef])
  useEffect(() => () => gate.current.dispose(), [])
  return armed
}

/** The size of an element in CSS pixels (a ResizeObserver, rounded so tiny changes do not re-render). `fallback` until measured and on the server. */
export function useBox(ref, fallback) {
  const [box, setBox] = useState(fallback)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const measure = () => {
      const r = el.getBoundingClientRect()
      const w = Math.round(r.width / 8) * 8
      const h = Math.round(r.height / 8) * 8
      if (w > 0 && h > 0) setBox(prev => (prev.w === w && prev.h === h ? prev : { w, h }))
    }
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    measure()
    return () => observer.disconnect()
  }, [ref])
  return box
}

export function useNow() {
  const { clock } = getRuntime()
  return useSyncExternalStore(clock.subscribe, clock.getNow, clock.getNow)
}

/** The locale and translator, following Hermes' language and the plugin's own override. */
export function useT() {
  const rt = getRuntime()
  const app = useI18n()
  const preference = useSyncExternalStore(rt.localePref.subscribe, rt.localePref.get, rt.localePref.get)
  const navigatorLanguages = typeof navigator !== 'undefined' && navigator.languages ? Array.from(navigator.languages) : []
  const appLocale = app && typeof app.locale === 'string' ? app.locale : null
  const locale = resolveLocale({ preference, appLocale, navigatorLanguages: [...navigatorLanguages] })
  rt.noteAppLocale(appLocale)
  const t = useMemo(() => makeT(locale), [locale])
  return { t, locale, preference }
}
