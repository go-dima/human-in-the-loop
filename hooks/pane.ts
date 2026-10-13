import type { Editing, Task } from '../types'
import { isActive } from './tasks'
import { ago, cellsOf, plural, printable, rowsOf } from './text'

/**
 * The longest title the pane and the transcript draw. `assign_task` takes
 * titles of at most MAX_TITLE characters; this bounds what an older version
 * or another session left in the store, never a title assigned now.
 */
export const MAX_SHOWN_TITLE = 300

/** The columns between two buttons in a row of them. */
export const BUTTON_GAP = 3

/** The cells before a task's text: its glyph, `☐ `. */
const GLYPH_CELLS = 2

/**
 * What the My tasks pane draws from: the tasks, which is selected and which
 * field is open, and what each row's words depend on. The render hook and
 * `rowsFor` both read it, so the rows asked for are the rows drawn.
 */
export type PaneView = {
  shown: readonly Task[]
  selectedId: number | null
  editing: Editing | null
  /** The draft in the open answer field. */
  draft: string
  nowMs: number
  sessionId: string
  isWorking: boolean
  /** The surface draws a text field (the mobile app draws none yet). */
  canType: boolean
  isFocused: boolean
}

export function selectedOf(view: PaneView): Task | undefined {
  const active = view.shown.filter(isActive)

  return active.find(task => task.id === view.selectedId) ?? active[0]
}

export function headlineOf(view: PaneView): { glyph: string; headline: string; note: string } {
  const active = view.shown.filter(isActive).length
  const saved = view.shown.length - active

  return {
    glyph: active > 0 ? '☐ ' : '✓ ',
    headline: active > 0 ? `${plural(active, 'task')} for you` : `${plural(saved, 'response')} not sent yet`,
    note: active > 0 && saved > 0 ? ` · ${saved} not sent yet` : '',
  }
}

/** A task's whole title, safe to draw. */
export function nameOf(task: Task): string {
  return printable(task.title, MAX_SHOWN_TITLE)
}

/** `#3 Rotate the token`: a task's number and its whole title. */
export function titleOf(task: Task): string {
  return `#${task.id} ${nameOf(task)}`
}

/** `  3m · from an earlier session`, drawn dim after an open task's title. */
export function ageOf(task: Task, view: Pick<PaneView, 'nowMs' | 'sessionId'>): string {
  const earlier = task.sessionId === view.sessionId ? '' : ' · from an earlier session'

  return `  ${ago(view.nowMs - task.createdMs)}${earlier}`
}

export function whyOf(task: Task): string {
  return printable(task.why, 300)
}

export function doneWhenOf(task: Task): string | undefined {
  return task.doneWhen === undefined ? undefined : `Done when: ${printable(task.doneWhen, 300)}`
}

/** A saved response's row: its task, and that it waits. */
export function savedOf(task: Task): string {
  return `${titleOf(task)} · not sent yet`
}

/** The selected task's buttons, as `hotkey` and `label`. */
export function actionsOf(task: Task, canType: boolean): { key: string; hotkey: string; label: string; option?: string }[] {
  const choices =
    task.kind === 'choose' && task.options !== undefined
      ? task.options.map((option, i) => ({ key: `option-${i + 1}`, hotkey: String(i + 1), label: printable(option, 60), option }))
      : [{ key: 'done', hotkey: 'd', label: 'Done' }]

  const typed = canType
    ? [
        { key: 'answer', hotkey: 'r', label: task.kind === 'choose' ? 'Other…' : 'Answer…' },
        { key: 'reject', hotkey: 'x', label: 'Reject…' },
      ]
    : [{ key: 'reject', hotkey: 'x', label: 'Reject' }]

  return [...choices, ...typed]
}

export const ANSWER_LABEL = 'Answer › '
export const REASON_LABEL = 'Reason (optional) › '
export const REASON_PLACEHOLDER = 'Enter rejects it'
export const HELD =
  'This looks like a secret. Claude and the transcript on disk would see it. Put it where it belongs and press Done instead.'

export function answerPlaceholderOf(view: PaneView): string {
  if (!view.isWorking) {
    return 'Enter sends it to Claude'
  }

  return view.shown.filter(isActive).length > 1
    ? 'Enter saves it; Claude gets it with your other answers'
    : 'Enter saves it; Claude gets it when this turn ends'
}

/** The answer field's buttons. */
export function answerButtonsOf(view: PaneView): string[] {
  return [view.isWorking ? 'Send now' : 'Save for later', 'Long answer…', 'Cancel']
}

/** The first saved row's Send now answers `s`. */
export function sendLabelOf(i: number): string {
  return i === 0 ? 's: Send now' : 'Send now'
}

export function hintOf(view: PaneView): string {
  return view.isFocused ? 'Esc: back to the prompt' : 'Click, or press ctrl+x tab to use the keys'
}

export const HIDE = 'Hide'

/** The rows a row of buttons takes in `columns`, wrapping between buttons. */
export function buttonRowsOf(labels: readonly string[], columns: number): number {
  let rows = 1
  let x = 0

  for (const label of labels) {
    const width = cellsOf(label)

    if (x > 0 && x + BUTTON_GAP + width > columns) {
      rows += 1
      x = width
    } else {
      x += (x > 0 ? BUTTON_GAP : 0) + width
    }
  }

  return rows
}

/**
 * The rows the My tasks pane's body takes at `columns` cells across, each
 * text wrapped as the pane draws it: the head, the selected task whole, a
 * row (or more, for a long title) for every other task, and the foot; at
 * most `max`.
 */
export function rowsFor(view: PaneView, columns: number, max: number): number {
  const width = Math.max(1, columns)
  const inner = Math.max(1, width - GLYPH_CELLS)
  const active = view.shown.filter(isActive)
  const saved = view.shown.filter(task => !isActive(task))
  const selected = selectedOf(view)
  const head = headlineOf(view)
  let rows = rowsOf(`${head.glyph}${head.headline}${head.note}`, width) + 1

  for (const task of active) {
    if (task !== selected) {
      // `#2` is the button that selects it; the title wraps beside it.
      rows += rowsOf(` ${nameOf(task)}${ageOf(task, view)}`, Math.max(1, inner - cellsOf(`#${task.id}`)))
      continue
    }

    rows += rowsOf(`${titleOf(task)}${ageOf(task, view)}`, inner)
    rows += rowsOf(whyOf(task), inner)
    const doneWhen = doneWhenOf(task)
    rows += doneWhen === undefined ? 0 : rowsOf(doneWhen, inner)
    rows += controlRowsOf(task, view, inner)
  }

  saved.forEach((task, i) => {
    rows += rowsOf(savedOf(task), Math.max(1, inner - 2 - cellsOf(sendLabelOf(i))))
  })

  rows += 1 + rowsOf(hintOf(view), Math.max(1, width - BUTTON_GAP - cellsOf(HIDE)))

  return Math.min(max, rows)
}

function controlRowsOf(task: Task, view: PaneView, columns: number): number {
  const field = view.editing !== null && view.editing.id === task.id ? view.editing : null

  if (field === null || !view.canType) {
    return buttonRowsOf(
      actionsOf(task, view.canType).map(action => `${action.hotkey}: ${action.label}`),
      columns,
    )
  }

  if (field.field === 'reason') {
    return rowsOf(`${REASON_LABEL}${REASON_PLACEHOLDER}`, columns) + 1
  }

  if (field.held !== undefined) {
    return rowsOf(HELD, columns) + buttonRowsOf(['Edit', 'Send anyway'], columns)
  }

  const shown = view.draft === '' ? answerPlaceholderOf(view) : view.draft

  return rowsOf(`${ANSWER_LABEL}${shown}`, columns) + buttonRowsOf(answerButtonsOf(view), columns)
}
