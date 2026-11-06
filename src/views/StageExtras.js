// Small stage widgets: the assistant name editor and the read-only Kanban status line.

import { useState } from 'react'

import { NAME_MAX, PRESETS, sanitizeName } from '../model/assistant.js'
import { selectKanbanLine } from '../model/kanban.js'
import { h } from './h.js'
import { getRuntime, useAssistantState, useKanbanState, useNow } from './hooks.js'

export function NameEditor({ t }) {
  const rt = getRuntime()
  const { name } = useAssistantState()
  const [draft, setDraft] = useState(null)
  const [message, setMessage] = useState('')
  const value = draft === null ? name : draft

  async function apply(next) {
    const out = await rt.setAssistantName(next)
    if (!out.ok) {
      setMessage(t('stage.assistantBad'))
      return
    }
    setDraft(null)
    setMessage(rt.assistant.getState().synced ? t('stage.assistantSaved') : t('stage.assistantLocal'))
  }

  return h(
    'details',
    { className: 'jh-name' },
    h('summary', null, `${t('stage.assistantName')}: ${name}`),
    h(
      'form',
      {
        className: 'jh-name-form',
        onSubmit: event => {
          event.preventDefault()
          void apply(value)
        }
      },
      h('label', { className: 'jh-name-label' }, t('stage.assistantName'), h('input', { type: 'text', className: 'jh-input', value, maxLength: NAME_MAX * 2, 'aria-describedby': 'jh-name-hint', onChange: event => { setDraft(event.target.value); setMessage('') } })),
      h('button', { type: 'submit', className: 'jh-btn jh-btn-sm', disabled: !sanitizeName(value) }, t('stage.assistantApply')),
      PRESETS.map(preset => h('button', { key: preset, type: 'button', className: 'jh-btn jh-btn-sm', 'aria-pressed': String(name === preset), title: t('stage.assistantPreset', { name: preset }), onClick: () => void apply(preset) }, preset))
    ),
    h('p', { id: 'jh-name-hint', className: 'jh-faint' }, message || t('stage.assistantHint'))
  )
}

export function KanbanLine({ t }) {
  const state = useKanbanState()
  const now = useNow()
  const line = selectKanbanLine(state, now)
  if (!line) return null
  const who = line.assignee || line.profile || t('kanban.line.nobody')
  const text = line.kind ? t(`kanban.line.${line.kind}`, { task: line.taskId, who }) : ''
  return h(
    'section',
    { className: 'jh-kanban-line', 'aria-label': t('kanban.line.title') },
    h('h3', { className: 'jh-section-title' }, t('kanban.line.title')),
    text ? h('p', { className: 'jh-kanban-text', role: 'status' }, text) : null,
    h('p', { className: 'jh-faint' }, t('kanban.line.counts', { working: line.working, blocked: line.blocked }))
  )
}
