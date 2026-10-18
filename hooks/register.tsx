import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptSubmitResult, Register, Timer, ToolSpec } from 'claude-code'

import type { Editing, Task, Took } from '../types'
import {
  MAX_OPEN,
  MAX_TITLE,
  answerIn,
  assignedOf,
  bridgeOf,
  contextOf,
  digestOf,
  isActive,
  isShown,
  listOf,
  looksSecret,
  messageOf,
  newsHeadOf,
  ownHeadOf,
  parseAsk,
  sameAsk,
  statusOf,
} from './tasks'
import {
  ANSWER_LABEL,
  BUTTON_GAP,
  HELD,
  HIDE,
  MAX_SHOWN_TITLE,
  REASON_LABEL,
  REASON_PLACEHOLDER,
  actionsOf as actionsFor,
  ageOf,
  answerButtonsOf,
  answerPlaceholderOf,
  doneWhenOf,
  headlineOf,
  hintOf,
  nameOf,
  rowsFor,
  savedOf,
  selectedOf,
  titleOf,
  whyOf,
} from './pane'
import type { PaneView } from './pane'
import {
  HEARTBEAT_MS,
  adopt,
  editedLegacy,
  elsewhereIn,
  floorOf,
  hasLegacyPeer,
  isEmptyEdit,
  isSlot,
  isTakenFrom,
  keysOf,
  legacyOf,
  projectOf,
  prune,
  withSlots,
} from './project'
import type { Adoption, LegacyEdit, Project, Slot } from './project'
import { numbersOf, oneLine, printable } from './text'

const PLUGIN = 'human-in-the-loop'

const ASSIGN = 'mcp__human-in-the-loop__assign_task'
const LIST = 'mcp__human-in-the-loop__list_tasks'
const WITHDRAW = 'mcp__human-in-the-loop__withdraw_task'

/**
 * Three lines at the end of the system prompt: where an ask for the user goes
 * so it stays in front of them, that a review is one even when the reply asks
 * for it too (the user is often busy and lets the reply's question go by),
 * and where they see it. Said as what to do,
 * never what not to: nothing here stops Claude reminding the user of a task.
 */
const STEERING = [
  "When you need something only the user can do (a secret put in place, an action on their machine or an account you can't reach, a decision that's theirs), assign it with mcp__human-in-the-loop__assign_task so it stays in front of them until they act on it.",
  'That includes asking the user to review or approve your work: assign it as a task even when you also ask in your reply, since they may be busy with other things when you ask, and the task keeps it in front of them.',
  'The user sees open tasks in their My tasks pane, or opens it with /my-tasks, and their response reaches you as a message.',
].join('\n')

/** Resolutions pressed this close together go to Claude as one message. */
const BATCH_MS = 800

/** The longest a person, or Claude, waits on the store: what it doesn't answer by then finishes on its own. */
const STORE_WAIT_MS = 5000

/** What a tool answers while the session moves to another folder, before it has read that folder's tasks. */
const MOVING = 'This session is still joining its project: the task store is slow to answer. Try again in a moment.'

/** The pane the tasks wait in, and the command that opens it. */
const PANE = 'my-tasks'
const PANE_TITLE = 'My tasks'
const MAX_PANE_ROWS = 18

const TOOLS: readonly ToolSpec[] = [
  {
    name: 'assign_task',
    description: [
      'Give the user a task that only they can do, and keep it in front of them until they act on it.',
      'Use it for a secret or credential they must put in place, an action on their machine or on an account you cannot reach (a dashboard, a device, a deploy approval), a decision that is theirs to make, or a review or approval of your work.',
      'Assign it even when you also ask in your reply: the user may be busy with other things, and the task keeps the ask in front of them.',
      'A task does not block: you keep working while it waits, and the response reaches you whenever the user gets to it, so it suits anything you need from them at some point in the session.',
      'AskUserQuestion is the blocking kind: it waits for the answer, so it suits what you need before you can go on.',
      'One task per need: list_tasks shows what is already open.',
      'Write the title as an imperative the user can act on without scrolling back.',
      'For a secret, ask the user to put it where it belongs and mark the task done, rather than paste it.',
      'The user sees open tasks in their My tasks pane, or opens it with /my-tasks.',
      'The user rejects (with a reason) or fulfills it (done, an option, or an answer in their words). Their response reaches you as a message, or when you call list_tasks.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'What the user should do, as an imperative they can act on without scrolling back. Under 80 characters.',
        },
        why: {
          type: 'string',
          description: 'One sentence: what it unblocks, or why only the user can do it.',
        },
        done_when: {
          type: 'string',
          description: "Optional: what counts as done. For a secret: \"It is in .env. Don't paste it here.\"",
        },
        kind: {
          type: 'string',
          enum: ['do', 'answer', 'choose'],
          description: 'do: the user does something and marks it done. answer: you need their words (an error, a log, test results). choose: they pick one of options.',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 4,
          description: 'For choose only: 2 to 4 short options.',
        },
      },
      required: ['title', 'why', 'kind'],
    },
  },
  {
    name: 'list_tasks',
    description: [
      'List the tasks you gave the user and what they did with them: accepted, done (with their answer or choice), rejected (with their reason).',
      'Call it when you are about to need a task\'s result, when told an answer is saved for you, or before assigning, to avoid a duplicate.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        show: {
          type: 'string',
          enum: ['updates', 'open', 'all'],
          description: 'updates (the default): open tasks and responses you have not seen. open: open tasks only. all: every task this session.',
        },
        id: { type: 'number', description: 'One task, whole, by its number.' },
      },
    },
  },
  {
    name: 'withdraw_task',
    description: 'Take back a task you gave the user when you no longer need it: you found another way, or the plan changed. The user sees the reason.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The task\'s number.' },
        reason: { type: 'string', description: 'One short sentence the user sees.' },
      },
      required: ['id'],
    },
  },
]

const tasks = atom({ plugin: 'human-in-the-loop', key: 'tasks' } as const, [] as readonly Task[])
const nextId = atom({ plugin: 'human-in-the-loop', key: 'nextId' } as const, 1)
const took = atom({ plugin: 'human-in-the-loop', key: 'took' } as const, {} as Readonly<Record<string, Took>>)
const selectedId = atom({ plugin: 'human-in-the-loop', key: 'selectedId' } as const, null as number | null)
const editing = atom({ plugin: 'human-in-the-loop', key: 'editing' } as const, null as Editing | null)
const loadedFor = atom({ plugin: 'human-in-the-loop', key: 'loadedFor' } as const, null as string | null)
const isWorking = atom({ plugin: 'human-in-the-loop', key: 'isWorking' } as const, false)

/**
 * Send now goes to Claude as a message (`auto` while it is idle), Save for
 * later waits (`auto` while it works) until its turn ends with every task
 * answered, a later answer while it is idle, or the user's next prompt.
 */
type How = 'auto' | 'now' | 'later'

/**
 * What a toast says when a prompt carrying updates is dropped: why (`why`,
 * the mod's own prompt, which the user didn't type), only that they're kept
 * (`kept`, an answer the user typed, whose drop the engine shows), or nothing
 * (`nothing`, the user's own prompt, which they rode: they wait as before).
 */
type DropNote = 'why' | 'kept' | 'nothing'

/** A prompt as it entered: its words, and the blocks that go beside them. */
type Entered = { text: string; context?: readonly string[] }

/**
 * What a sync changed of what the session shows: nothing (`same`), the tasks
 * another session took on (`lost`), or everything, taking the project on
 * (`joined`).
 */
type Synced = 'same' | 'lost' | 'joined'

/** What the module tracks beside `$.state`; a hot reload starts it over. */
const live = {
  sessionId: '',
  root: '',
  /** A Send now row joined the running turn and no step has read it yet. */
  isUnread: false,
  /** A Send now the running turn could not take: it goes once the turn ends. */
  isSendingAtEnd: false,
  /** What the user has typed in an answer field so far, by task. */
  drafts: new Map<number, string>(),
  batch: null as Timer | null,
  /** Says in the project's store that this session is alive. */
  heartbeat: null as Timer | null,
  /** Tasks waiting in the project's other live sessions. */
  elsewhere: 0,
  /** The project's next task number at its last reading. */
  floor: 1,
  /** A 0.1.4 session was alive in the project at its last reading. */
  hasLegacyPeer: false,
  /** The session has a slot in the project's store: it writes it, its count in it, until it ends. */
  hasSlot: false,
  /** When the session's slot was last written. */
  writtenMs: 0,
  /** When the session last read the project. */
  readMs: 0,
  /** Set once the session ended: its slot says so from then on. */
  endedMs: undefined as number | undefined,
  /** How many sessions of the process have ended: one that ends before its join comes up in the queue stays ended. */
  ends: 0,
  /** Responses a prompt entered without, by `updateKeyOf`: they go with Send now or the next prompt, not as a turn ends. */
  held: new Set<string>(),
  /** Joins into another folder not done yet: until then the tasks the process holds are the folder's it leaves. */
  moving: 0,
  /** The store work asked for and not yet done: each piece waits for the one before. */
  queue: Promise.resolve() as Promise<unknown>,
  /** Store work a wait gave up on, not settled yet: while there is any, nothing waits on the store. */
  stalled: 0,
  /**
   * Turns begun and not yet ended. `turn.start` names no loop, so a loop
   * other than main's (an engine side request, a teammate) may begin one that
   * ends under an agent id: each ends by its own id.
   */
  turns: new Set<string>(),
  /** Whether a turn runs, in the engine's own word (the band's `isWorking`), once it has said. */
  engineWorking: undefined as boolean | undefined,
  /**
   * The pane's body as last drawn: its width, whether it draws a field and
   * holds the keys; until it is first drawn, an 80-column terminal's.
   */
  columns: 76,
  canType: true,
  isFocused: false,
  /** The rows the pane last asked for. */
  rows: 0,
}

/** Whether Claude is at work: the engine's word when it has given one, else the turns begun and not ended. */
function working(): boolean {
  return live.engineWorking ?? live.turns.size > 0
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    for (const tool of TOOLS) {
      await $.tool.register(tool)
    }

    await $.command.register({ name: 'my-tasks', description: 'Show the tasks Claude gave you' })
    await join($)

    return next(e)
  })

  // An ended session's tasks wait in the store for the next session in the
  // project. After /clear or a resume the process goes on as another session
  // with no session.start, so it joins the project again here.
  on('session.end', async ($, e, next) => {
    live.heartbeat?.cancel()
    live.heartbeat = null
    live.endedMs = await $.clock.now()
    live.ends += 1
    const ends = live.ends

    // The slot marked ended, in one write and no read, once the store work in
    // flight is done; a session that never read the project reads it first.
    // The exit's budget is short, and the end waits for the write only
    // through half of what is left: a slot not written by then goes stale,
    // and the next session takes it on then. A process that goes on makes
    // the write all the same, before it joins again.
    const written = queued(async () => ((await isLoaded($)) ? writeOwn($) : load($))).catch(() => undefined)
    const leftMs = next.budget.remainingMs

    await (Number.isFinite(leftMs) ? Promise.race([written, $.clock.sleep(leftMs / 2)]) : written)

    const ended = await next(e)

    if (e.reason === 'clear' || e.reason === 'resume') {
      // With the count as this session ended: the next one, ending before
      // the join runs, stays ended.
      $.clock.after(0, () => void join($, ends))
    }

    return ended
  })

  on('command.run', { command: 'my-tasks' }, async $ => {
    await wake($)

    if ((await read($, tasks)).filter(isShown).length === 0) {
      return { text: 'No tasks for you right now.' }
    }

    await show($, true)

    return {}
  })

  // The tools stay in the prompt's list, descriptions and all, where an MCP
  // tool would wait behind ToolSearch: the description is what steers Claude
  // to assign a task, so the ask stays in front of the user.
  on('tool.describe', { tool: 'mcp__human-in-the-loop__assign_task' }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
  on('tool.describe', { tool: 'mcp__human-in-the-loop__list_tasks' }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
  on('tool.describe', { tool: 'mcp__human-in-the-loop__withdraw_task' }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))

  on('tool.call', { tool: ASSIGN }, async ($, e) => {
    if (e.agentId !== undefined) {
      return { deny: 'Only the main agent assigns tasks to the user. Say what you need from the user in your result instead.' }
    }

    const ask = parseAsk(e as unknown as Record<string, unknown>)

    if ('error' in ask) {
      return { deny: ask.error }
    }

    // Resumed into another folder, the session takes it on once the store
    // work in flight is done and it has read it. A task assigned before then
    // is the old folder's: the join drops it here, and the old session's end
    // write may leave it there.
    if (live.moving > 0) {
      return { deny: MOVING }
    }

    // Task numbers count per project, across its sessions: the next is past
    // every number a session there drew, which each slot carries, so this
    // reads the project first (and lets go of tasks taken on while the
    // session slept). Two sessions assigning at the same moment can still
    // draw one number; each shows and answers only its own, and where their
    // tasks meet (one taking on the other's), `adopt` gives the later a new one.
    await beat($, false)

    const active = (await read($, tasks)).filter(isActive)
    const same = active.find(task => sameAsk(task.title, ask.title))

    if (same !== undefined) {
      return { result: `Task #${same.id} already asks the user for this ("${same.title}"); nothing new was assigned.` }
    }

    if (active.length >= MAX_OPEN) {
      return {
        deny: `The user already has ${MAX_OPEN} open tasks. Withdraw one you no longer need, or wait for them to act (list_tasks shows them).`,
      }
    }

    const id = (await update($, nextId, n => Math.max(n, live.floor) + 1)) - 1
    const nowMs = await $.clock.now()
    const task: Task = {
      id,
      ...ask,
      state: 'open',
      update: 'none',
      // The conversation's own: until it joins the project (a store slow
      // after /clear), the process still acts for the one it left.
      sessionId: await $.session.id(),
      createdMs: nowMs,
      updatedMs: nowMs,
    }

    await change($, list => [...list, task])

    if (live.hasLegacyPeer) {
      await awaited($, queued(() => editLegacy($, { removed: [], taken: {} })))
    }

    await update($, selectedId, chosen => chosen ?? id)

    if (!(await show($, false))) {
      $.ui.toast(`Claude assigned you a task: ${printable(task.title, MAX_TITLE)}. See /my-tasks`)
    }

    return { result: assignedOf(task, active.length + 1) }
  })

  on('tool.call', { tool: LIST }, async ($, e) => {
    if (live.moving > 0) {
      return { deny: MOVING }
    }

    await wake($)
    const args = e as unknown as Record<string, unknown>
    const id = typeof args['id'] === 'number' ? args['id'] : undefined
    const scope = args['show'] === 'open' || args['show'] === 'all' ? args['show'] : 'updates'
    const list = await read($, tasks)

    const picked =
      id !== undefined
        ? list.filter(task => task.id === id)
        : scope === 'all'
          ? list
          : scope === 'open'
            ? list.filter(isActive)
            : list.filter(isShown)

    if (id !== undefined && picked.length === 0) {
      return { result: `No task #${id}.` }
    }

    // A subagent's read tells the main agent nothing.
    if (e.agentId === undefined) {
      await claim($, task => picked.some(one => one.id === task.id))
    }

    return { result: listOf(picked, await $.clock.now()) }
  })

  on('tool.call', { tool: WITHDRAW }, async ($, e) => {
    if (e.agentId !== undefined) {
      return { deny: 'Only the main agent withdraws tasks.' }
    }

    if (live.moving > 0) {
      return { deny: MOVING }
    }

    await wake($)
    const args = e as unknown as Record<string, unknown>
    const id = args['id']
    const reason = typeof args['reason'] === 'string' ? oneLine(args['reason']) : ''
    const task = (await read($, tasks)).find(one => one.id === id)

    if (task === undefined) {
      return { deny: `No task #${String(id)}.` }
    }

    if (!isActive(task)) {
      return { deny: `Task #${task.id} is already ${task.state}; there is nothing to withdraw.` }
    }

    await edit($, task.id, one => ({
      ...one,
      state: 'withdrawn',
      update: 'delivered',
      ...(reason === '' ? {} : { reason }),
    }))
    await settle($, task.id)
    const why = reason === '' ? '' : `. ${printable(reason, 200)}`
    $.ui.toast(`Claude withdrew the task: ${printable(task.title, MAX_TITLE)}${why}`, { timeoutMs: 8000 })

    return { result: `Withdrew task #${task.id}; it is gone from the user's My tasks pane.` }
  })

  on('turn.start', async ($, e, next) => {
    live.isUnread = false
    live.turns.add(e.turnId)
    await syncWorking($)

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      live.isUnread = false
    }

    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    // Main's turn ending ends every turn; another loop's ends its own.
    if (e.agentId === undefined) {
      live.turns.clear()
      live.engineWorking = false
    } else {
      live.turns.delete(e.turnId)
    }

    await syncWorking($)

    if (e.agentId === undefined) {
      // Answers saved while Claude worked go now that it's free, unless a
      // task is still open: then they go with that last answer, together.
      // One a prompt entered without waits for Send now or the next prompt.
      const all = await read($, tasks)
      const isAllAnswered = all.some(task => task.update === 'pending' && !live.held.has(updateKeyOf(task))) && !all.some(isActive)

      if (live.isSendingAtEnd || isAllAnswered) {
        live.isSendingAtEnd = false
        // This message wakes Claude, which reads any row it missed above it.
        live.isUnread = false
        void send($, true)
      } else if (live.isUnread) {
        // A Send now that joined the turn during its final reply sits in the
        // conversation with no step left to read it: wake Claude up for it.
        live.isUnread = false
        void $.prompt.submit({ text: 'I answered a task while you were finishing your reply; my answer is above.', asUser: true })
      }
    }

    return result
  })

  // Draws nothing and passes the band on: it only reads the engine's word on
  // whether a turn runs, which no turn event gives for every loop.
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (live.engineWorking !== e.props.isWorking) {
      live.engineWorking = e.props.isWorking
      $.clock.after(0, () => void syncWorking($))
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if ((e.origin.kind === 'plugin' && e.origin.name === PLUGIN) || live.moving > 0) {
      return next(e)
    }

    await wake($)
    const bridged = answerIn(e.text)
    const task = bridged === null ? undefined : (await read($, tasks)).find(one => one.id === bridged.id && isActive(one))

    if (bridged !== null && task !== undefined) {
      if (looksSecret(bridged.answer)) {
        return {
          drop: `This looks like a secret, so it wasn't sent. Put it where it belongs, then mark #${task.id} Done.`,
        }
      }

      const given = bridged.answer === '' ? {} : { answer: bridged.answer }

      if (e.turnId !== undefined) {
        await resolve($, task.id, { state: 'done', ...given }, 'later')
        const when = (await read($, tasks)).some(isActive) ? 'with your other answers' : 'when this turn ends'

        return {
          drop: `Saved as your answer to #${task.id}. Claude gets it ${when}, or press Send now in /my-tasks.`,
        }
      }

      // Claude is idle: this prompt is the answer, sent with every other
      // update Claude has not heard, those a batch was about to send among them.
      live.batch?.cancel()
      live.batch = null
      await resolve($, task.id, { state: 'done', ...given }, 'later')
    }

    const due = await claim($)
    // A task still here has its answer in this prompt, or in another send
    // that took it as it was saved. One gone meanwhile (another session took
    // it on) leaves the prompt as typed.
    const isAnswer = task !== undefined && (await read($, tasks)).some(one => one.id === task.id)

    if (isAnswer && due.length === 0) {
      return { drop: `Your answer to #${task.id} already went to Claude.` }
    }

    if (due.length === 0) {
      return next(e)
    }

    if (isAnswer) {
      return passOn($, due, inWords, 'kept', () => next({ ...e, text: messageOf(due) }))
    }

    return passOn($, due, inDigest, 'nothing', () => next({ ...e, context: [...(e.context ?? []), digestOf(due)] }))
  })

  // Read at a conversation's start and again after a compaction: what is
  // still with the user, so Claude neither forgets nor assigns it twice.
  // Added last, on the session's side of the cache boundary, wherever the
  // tool can be reached: offered outright, or found through ToolSearch.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const isReachable = e.tools.some(tool => tool === ASSIGN || tool === 'ToolSearch')

    if (!isReachable || e.traits.includes('print') || e.traits.includes('bare')) {
      return composed
    }

    return { sections: [...composed.sections, { id: 'human-in-the-loop:tasks', text: STEERING, scope: 'session' }] }
  })

  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    const shown = (await read($, tasks)).filter(isShown)

    if (shown.length === 0 || live.moving > 0) {
      return result
    }

    return { ...result, blocks: [...result.blocks, { name: 'humanInTheLoop', text: contextOf(shown, await $.session.id()) }] }
  })

  on('ui.render', { component: 'ToolUse', props: { tool: ASSIGN } }, ($, e, next) => {
    const input = e.props.input as Record<string, unknown> | null | undefined
    const title = typeof input?.['title'] === 'string' ? input['title'] : ''

    if (title === '' || e.props.isErrored || e.props.isInterrupted) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)

    return (
      // One text, so the label keeps its words whole and the title wraps after it.
      <Text wrap="wrap">
        <Text color="yellow">{'☐ '}</Text>
        <Text bold>{'Assigned you a task: '}</Text>
        {printable(title, MAX_SHOWN_TITLE)}
      </Text>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // The mobile app draws no field yet: answers and reasons wait for a surface that does.
    const Input = 'Input' in elements ? elements.Input : undefined
    const view = await paneView($, { canType: Input !== undefined, isFocused: e.props.isFocused })

    // The pane asks for the rows its tree takes at the width it is drawn in:
    // a long title wraps, and a pane sized for one row would cut off the rest.
    live.columns = e.props.bodyColumns
    live.canType = view.canType
    live.isFocused = view.isFocused

    if (e.props.placement === 'inline' && rowsFor(view, live.columns, MAX_PANE_ROWS) !== live.rows) {
      void fit($)
    }

    const { shown, editing: field, isWorking: working } = view

    if (shown.length === 0) {
      return <Text dimColor>No tasks for you right now.</Text>
    }

    const active = shown.filter(isActive)
    const saved = shown.filter(task => !isActive(task))
    const selected = selectedOf(view)
    const head = headlineOf(view)

    // The glyph keeps its cells beside a title that wraps.
    const glyph = (
      <Box flexShrink={0}>
        <Text color="yellow">{'☐ '}</Text>
      </Box>
    )

    // The title and its age are one text, so a long title wraps under itself
    // and the age follows it, never squeezed into a column of its own.
    const titleText = (task: Task, isBold: boolean) => (
      <Text wrap="wrap">
        <Text bold={isBold}>{titleOf(task)}</Text>
        <Text dimColor>{ageOf(task, view)}</Text>
      </Text>
    )

    const actionsOf = (task: Task) => (
      <Box key="actions" flexDirection="row" flexWrap="wrap" columnGap={BUTTON_GAP}>
        {actionsFor(task, view.canType).map(action => (
          <Button
            key={action.key}
            plain
            hotkey={action.hotkey}
            label={action.label}
            onPress={() => {
              if (action.option !== undefined) {
                return resolve($, task.id, { state: 'done', answer: action.option }, 'auto')
              }

              if (action.key === 'done') {
                return resolve($, task.id, { state: 'done' }, 'auto')
              }

              if (action.key === 'answer') {
                return startEditing($, task.id, 'answer')
              }

              return view.canType ? startEditing($, task.id, 'reason') : resolve($, task.id, { state: 'rejected' }, 'auto')
            }}
          />
        ))}
      </Box>
    )

    const answerField = (task: Task, held: string | undefined) => {
      if (Input === undefined) {
        return null
      }

      if (held !== undefined) {
        return (
          <Box key="held" flexDirection="column">
            <Text color="yellow" wrap="wrap">
              {HELD}
            </Text>
            <Box flexDirection="row" flexWrap="wrap" columnGap={BUTTON_GAP}>
              <Button key="edit" plain label="Edit" onPress={() => update($, editing, (): Editing => ({ id: task.id, field: 'answer' }))} />
              <Button key="send-anyway" plain label="Send anyway" onPress={() => answer($, task.id, held, 'auto', true)} />
            </Box>
          </Box>
        )
      }

      const [otherWay, long, cancel] = answerButtonsOf(view)

      return (
        <Box key="field" flexDirection="column">
          <Input
            key="answer"
            label={ANSWER_LABEL}
            placeholder={answerPlaceholderOf(view)}
            value={live.drafts.get(task.id) ?? ''}
            submitLabel={working ? 'save' : 'send'}
            autoFocus
            onInput={value => {
              live.drafts.set(task.id, value)
            }}
            onSubmit={value => answer($, task.id, value, 'auto')}
          />
          <Box flexDirection="row" flexWrap="wrap" columnGap={BUTTON_GAP}>
            <Button
              key="other-way"
              plain
              label={otherWay}
              onPress={() => answer($, task.id, live.drafts.get(task.id) ?? '', working ? 'now' : 'later')}
            />
            <Button key="long" plain label={long} onPress={() => longAnswer($, task.id)} />
            <Button key="cancel" plain label={cancel} onPress={() => stopEditing($)} />
          </Box>
        </Box>
      )
    }

    const reasonField = (task: Task) => {
      if (Input === undefined) {
        return null
      }

      return (
        <Box key="field" flexDirection="column">
          <Input
            key="reason"
            label={REASON_LABEL}
            placeholder={REASON_PLACEHOLDER}
            submitLabel="reject"
            autoFocus
            onSubmit={value => {
              const reason = oneLine(value)
              return resolve($, task.id, { state: 'rejected', ...(reason === '' ? {} : { reason }) }, 'auto')
            }}
          />
          <Button key="cancel" plain label="Cancel" onPress={() => stopEditing($)} />
        </Box>
      )
    }

    const selectedRows = (task: Task) => {
      const isEditing = field !== null && field.id === task.id
      const control = !isEditing
        ? actionsOf(task)
        : field.field === 'answer'
          ? answerField(task, field.held)
          : reasonField(task)
      const doneWhen = doneWhenOf(task)

      return (
        <Box key={`task-${task.id}`} flexDirection="column" flexShrink={0}>
          <Box flexDirection="row">
            {glyph}
            {titleText(task, true)}
          </Box>
          <Box flexDirection="column" paddingLeft={2}>
            <Text wrap="wrap">{whyOf(task)}</Text>
            {doneWhen === undefined ? null : (
              <Text dimColor wrap="wrap">
                {doneWhen}
              </Text>
            )}
            {control}
          </Box>
        </Box>
      )
    }

    const taskRows = active.map(task =>
      task.id === selected?.id ? (
        selectedRows(task)
      ) : (
        <Box key={`task-${task.id}`} flexDirection="row" flexShrink={0}>
          {glyph}
          <Box flexShrink={0}>
            <Button key={`select-${task.id}`} plain dimColor label={`#${task.id}`} onPress={() => select($, task.id)} />
          </Box>
          <Text dimColor wrap="wrap">
            {` ${nameOf(task)}${ageOf(task, view)}`}
          </Text>
        </Box>
      ),
    )

    const savedRows = saved.map((task, i) => (
      <Box key={`saved-${task.id}`} flexDirection="row" flexShrink={0}>
        <Box flexShrink={0}>{task.state === 'rejected' ? <Text color="red">{'✗ '}</Text> : <Text color="green">{'✓ '}</Text>}</Box>
        <Text dimColor wrap="wrap">
          {savedOf(task)}
        </Text>
        <Box flexShrink={0} marginLeft={2}>
          <Button key={`send-${task.id}`} plain {...(i === 0 ? { hotkey: 's' } : {})} label="Send now" onPress={() => sendNow($)} />
        </Box>
      </Box>
    ))

    return (
      <Box flexDirection="column">
        <Box key="head" flexDirection="row" flexShrink={0}>
          <Text wrap="wrap">
            <Text color={active.length > 0 ? 'yellow' : 'gray'}>{head.glyph}</Text>
            <Text bold>{head.headline}</Text>
            <Text dimColor>{head.note}</Text>
          </Text>
        </Box>
        <Box key="tasks" flexDirection="column" marginTop={1} flexShrink={0}>
          {taskRows}
          {savedRows}
        </Box>
        <Box key="foot" flexDirection="row" marginTop={1} columnGap={BUTTON_GAP} flexShrink={0}>
          <Text dimColor wrap="wrap">
            {hintOf(view)}
          </Text>
          <Box flexShrink={0}>
            <Button key="hide" plain dimColor role="dismiss" label={HIDE} onPress={() => $.ui.close({ id: PANE })} />
          </Box>
        </Box>
      </Box>
    )
  })
}

/** Keeps the pane's word on whether Claude works (Enter sends, or saves) in step. */
async function syncWorking($: EngineInterface) {
  const now = working()

  await update($, isWorking, () => now)
}

/**
 * Joins the project as this session: takes on its tasks, the store's slot
 * kept alive by a heartbeat, the status line and, for tasks taken on from an
 * earlier session, the pane.
 */
async function join($: EngineInterface, ends = live.ends) {
  const sessionId = await $.session.id()
  const root = await $.session.root()
  const isMoving = live.root !== '' && live.root !== root

  // A row of the conversation the process leaves is none of this one's.
  live.isUnread = false

  // After /clear the process goes on as a new session, with no slot yet: it
  // takes over once the old session's writes are done, and takes on what
  // the old one held, ended whether or not its end write landed (or, when
  // the old one never read the project, what the one before it held).
  // Resumed in another folder, it leaves that folder's tasks as its last
  // write there left them and starts on this one as a new process would,
  // keeping nothing it tracked of that project. A store that fails now
  // takes nothing on yet: the session writes nothing until it has read the
  // project, which the heartbeat tries again.
  const joined = queued(async () => {
    if (live.root !== '' && live.root !== root) {
      await update($, tasks, () => [])
      await update($, nextId, () => 1)
      await update($, took, () => ({}))
      await update($, selectedId, () => null)
      await update($, editing, () => null)
      await update($, loadedFor, () => null)
      live.drafts.clear()
      live.batch?.cancel()
      live.batch = null
      live.isSendingAtEnd = false
      live.elsewhere = 0
      live.floor = 1
      live.hasLegacyPeer = false
    }

    live.sessionId = sessionId
    live.root = root
    live.hasSlot = false
    live.writtenMs = 0
    live.readMs = 0

    // A session that ended while this waited in the queue (an exit right
    // after /clear, the store slow) reads the project as an ending session
    // does, and its end write, queued after this, marks its slot ended.
    if (live.ends === ends) {
      live.endedMs = undefined
    }

    return load($)
  }).catch(() => undefined)

  if (isMoving) {
    live.moving += 1
    void joined.then(() => {
      live.moving -= 1
    })
  }

  // Tasks from an earlier session: the status line says so, and the pane
  // opens where the terminal is wide enough to seat it unasked, unless the
  // session has ended since.
  const shown = joined
    .then(async () => {
      if ((await refresh($)) && live.ends === ends) {
        await show($, false)
      }
    })
    .catch(() => undefined)

  // One that ended before this ran has no heartbeat: its end stopped the last.
  if (live.ends === ends) {
    live.heartbeat?.cancel()
    live.heartbeat = $.clock.every(HEARTBEAT_MS, () => void beat($))
  }

  // A store slow to answer holds up the start 5 seconds at most: what the
  // session takes on shows once it answers.
  await awaited($, joined)
  await redrawn($, shown)
}

/**
 * Takes on the tasks this session owns in the project's store: its own (a
 * resumed session) and those of sessions that ended or went quiet. A live
 * session's tasks stay its own: answers go to the session that asked. A hot
 * reload keeps the session's tasks as they are.
 */
async function load($: EngineInterface) {
  if (await isLoaded($)) {
    await sync($)
    return
  }

  const nowMs = await $.clock.now()
  const stored = await readProject($)
  const holder = await read($, loadedFor)
  const notes = await read($, took)
  const count = await read($, nextId)
  let project = stored
  let adoption!: Adoption

  // Taken on against the task list as it stands when it changes hands, so a
  // press meanwhile is kept. `update` runs this again when another write
  // beat it: the last run is the list it wrote. The session's own tasks it
  // is done with, which no slot holds, stay in it, with the numbers its
  // Claude knows them by.
  await update($, tasks, current => {
    const done = current.filter(task => task.sessionId === live.sessionId && !isShown(task))
    project = withHeld(stored, holder, slotFrom(current, notes, count, nowMs), nowMs)
    adoption = adopt(project, live.sessionId, nowMs, done.map(task => task.id), live.endedMs !== undefined)

    return [...done, ...adoption.adopted].sort((a, b) => a.id - b.id)
  })

  live.readMs = nowMs
  live.hasSlot ||= live.sessionId in stored.slots
  await update($, nextId, n => Math.max(n, adoption.nextId))
  await update($, took, () => adoption.took)
  await update($, loadedFor, () => live.sessionId)
  live.elsewhere = elsewhereIn(project, live.sessionId, nowMs)
  live.floor = adoption.nextId
  live.hasLegacyPeer = hasLegacyPeer(project, live.sessionId, nowMs)
  await reselect($)

  try {
    // The slot first, noting what it took: only then do the slots it took from leave.
    await writeOwn($, adoption.removed.length > 0)
    await clean($, project, adoption.removed, adoption.legacy)
  } catch {
    // What it took on stands, and the caller shows it: the next heartbeat
    // makes the writes.
  }
}

/**
 * Whether the session has read the project as itself: until then, the store
 * may hold tasks of its own it hasn't taken on. `loadedFor` names the session
 * whose tasks the process holds.
 */
async function isLoaded($: EngineInterface): Promise<boolean> {
  return (await read($, loadedFor)) === live.sessionId
}

/**
 * The project as read, with what this process holds (`slot`) that the store
 * may not have. Held for another session (`holder`, the one it left at
 * /clear or a resume in place), it is that session's slot, ended: its end
 * write may have failed. The slot keeps the time the store has, so that it
 * leaves once this session's is written. Held for none (no session of the
 * process has read the project), it is the tasks its sessions assigned: each
 * session's beside the tasks the store holds for it, ended, unless it is this
 * one or the store doesn't show it ended. One alive or quiet there has been
 * resumed by another process since, or may have been: it keeps its slot, and
 * what it assigned here goes on in this one's.
 */
function withHeld(project: Project, holder: string | null, slot: Slot, nowMs: number): Project {
  if (holder !== null) {
    const stored = project.slots[holder]

    if (stored === undefined && slot.tasks.length === 0 && slot.took === undefined) {
      return project
    }

    return withSlots(project, { [holder]: { ...slot, seenMs: stored?.seenMs ?? 0, endedMs: nowMs } })
  }

  const own = live.sessionId
  const slots: Record<string, Slot> = {}

  for (const task of slot.tasks) {
    const stored = project.all[task.sessionId]
    const id = stored === undefined || stored.endedMs !== undefined ? task.sessionId : own
    const into = (slots[id] ??= { seenMs: 0, ...project.all[id], tasks: [], ...(id === own ? {} : { endedMs: nowMs }) })

    into.tasks.push(task)
  }

  for (const [id, held] of Object.entries(slots)) {
    held.tasks.push(...(project.all[id]?.tasks ?? []))
  }

  return withSlots(project, slots)
}

/**
 * Says this session is alive, and counts the tasks waiting in the project's
 * other sessions: `sync`, and a redraw of what it changed. Not `isWriting`
 * where a write follows (assigning). While store work given up on is still
 * out, it asks for no more: the first heartbeat after it settles syncs.
 */
async function beat($: EngineInterface, isWriting = true) {
  if (live.stalled > 0) {
    return
  }

  const was = live.elsewhere
  const synced = queued(() => sync($, isWriting)).catch((): Synced => 'same')
  const shown = synced
    .then(async change => {
      // A first read shows the project as joining does: the pane opens for
      // the tasks it took on.
      if ((change !== 'same' || live.elsewhere !== was) && (await refresh($)) && change === 'joined') {
        await show($, false)
      }
    })
    .catch(() => undefined)

  await awaited($, synced)
  await redrawn($, shown)
}

/**
 * Reads the project and acts on it: lets go of the tasks another session
 * took on while this one slept, keeps the notes of what this one took that
 * are still needed, counts the tasks waiting elsewhere, and writes the slot,
 * unless not `isWriting` (a write follows) and nothing leaves it or the
 * store: a task let go of leaves at once, since the caller may write nothing
 * after all (an ask that repeats one, say). A session that couldn't read the
 * project as it joined takes it on instead.
 * Resolves what changed of what it shows.
 */
async function sync($: EngineInterface, isWriting = true): Promise<Synced> {
  if (!(await isLoaded($))) {
    await load($)
    return 'joined'
  }

  const nowMs = await $.clock.now()
  const stored = await readProject($)
  const own = live.sessionId
  // With the session's own slot as it holds it: the store may not have its
  // last write, the note of tasks it took back among them.
  const project = withSlots(stored, { [own]: await slotOf($, nowMs) })
  const isLost = await letGo($, project)
  const pruned = prune(project, own, await read($, took), nowMs)

  await update($, took, () => pruned.took)
  live.readMs = nowMs
  live.hasSlot ||= own in stored.slots
  live.elsewhere = elsewhereIn(project, own, nowMs)
  live.floor = floorOf(project)
  live.hasLegacyPeer = hasLegacyPeer(project, own, nowMs)

  try {
    // The slot first: it carries the tasks let go of before the note that
    // told of them leaves, and the notes and count of a slot before it does.
    if (isWriting || isLost || pruned.removed.length > 0 || !isEmptyEdit(pruned.legacy)) {
      await writeOwn($, pruned.removed.length > 0)
    }

    await clean($, project, pruned.removed, pruned.legacy)
  } catch {
    // What it let go of stands, and the caller redraws it: the next
    // heartbeat makes the writes.
  }

  return isLost ? 'lost' : 'same'
}

/**
 * Lets go of the tasks another session took on while this one was quiet (a
 * laptop asleep, say): they are that session's now, and the user answers
 * them there. Resolves whether any of them was shown.
 */
async function letGo($: EngineInterface, project: Project): Promise<boolean> {
  const isTaken = (task: Task) => isTakenFrom(project, live.sessionId, task)
  const list = await read($, tasks)

  if (!list.some(isTaken)) {
    return false
  }

  const lost = list.filter(task => isTaken(task) && isShown(task))

  await update($, tasks, current => current.filter(task => !isTaken(task)))

  for (const task of lost) {
    await settle($, task.id)
  }

  if (lost.length > 0) {
    const which = numbersOf(lost.map(task => task.id))
    const [noun, them] = lost.length === 1 ? ['task', 'it'] : ['tasks', 'them']

    $.ui.toast(`Another session in this project took on ${noun} ${which} while this one was away. Answer ${them} there.`, {
      timeoutMs: 8000,
    })
  }

  return lost.length > 0
}

/**
 * Runs store work one piece at a time, in the order asked, so no write of
 * the session's lands after a newer one. No piece asks for another.
 */
function queued<T>(work: () => Promise<T>): Promise<T> {
  const done = live.queue.then(work, work)
  live.queue = done.catch(() => undefined)

  return done
}

/**
 * Resolves once store `work` settles, or `STORE_WAIT_MS` on: a press, a
 * prompt or a tool call goes on without a store that is slow to answer, and
 * the work finishes on its own, in its place in the queue. Until work given
 * up on settles, nothing waits on the store at all.
 */
async function awaited($: EngineInterface, work: Promise<unknown>) {
  if (live.stalled > 0) {
    return
  }

  if (!(await within($, work))) {
    const settled = () => {
      live.stalled -= 1
    }

    live.stalled += 1
    void work.then(settled, settled)
  }
}

/**
 * Resolves once the redraw that store work leads to settles, `STORE_WAIT_MS`
 * on, or at once while that work was given up on: it is no store work, so a
 * surface slow to open the pane holds up neither the store nor the heartbeat.
 */
async function redrawn($: EngineInterface, shown: Promise<unknown>) {
  if (live.stalled === 0) {
    await within($, shown)
  }
}

/** Resolves once `work` settles, or `STORE_WAIT_MS` on, whichever is first: whether it settled. */
function within($: EngineInterface, work: Promise<unknown>): Promise<boolean> {
  return new Promise(resolve => {
    const timer = $.clock.after(STORE_WAIT_MS, () => resolve(false))
    const done = () => {
      timer.cancel()
      resolve(true)
    }

    void work.then(done, done)
  })
}

/**
 * Reads the project: 0.1.4's value, when there is one, and each session's
 * slot, one read of the store each. Joining, the heartbeat and assigning
 * read it; a pane press or a prompt, which a person waits on, doesn't.
 */
async function readProject($: EngineInterface): Promise<Project> {
  const keys = keysOf(live.root)
  const wanted = (await $.store.keys()).filter(key => key === keys.legacy || key.startsWith(keys.prefix))
  const values = await Promise.all(wanted.map(key => $.store.get(key)))

  return projectOf(live.root, Object.fromEntries(wanted.map((key, i) => [key, values[i]])))
}

/**
 * Writes the session's slot from what it holds, under its own key: the one
 * key it writes. A session that never held a task has no slot, unless
 * `isForced`: its count must be in the store before a slot that carries one
 * leaves it. One that has a slot keeps it, its count in it, until it ends,
 * and the next session in the project removes it; it has one from the first
 * write it makes, landed or not, since a write that fails, the next one
 * makes, its tasks gone by then or not. A session that hasn't read the
 * project writes nothing: it would write over tasks of its own.
 */
async function writeOwn($: EngineInterface, isForced = false) {
  if (!(await isLoaded($))) {
    return
  }

  const nowMs = await $.clock.now()
  const slot = await slotOf($, nowMs)

  if (!live.hasSlot && !isForced && slot.tasks.length === 0 && slot.took === undefined) {
    return
  }

  live.hasSlot = true
  await $.store.set(keysOf(live.root).session(live.sessionId), slot)
  live.writtenMs = nowMs
}

/** The session's slot, from what it holds now. */
async function slotOf($: EngineInterface, nowMs: number): Promise<Slot> {
  return slotFrom(await read($, tasks), await read($, took), await read($, nextId), nowMs)
}

/** The session's slot, holding `list`, its `notes` of what it took, and its count. */
function slotFrom(list: readonly Task[], notes: Readonly<Record<string, Took>>, count: number, nowMs: number): Slot {
  return {
    tasks: list.filter(isShown),
    seenMs: nowMs,
    nextId: count,
    ...(Object.keys(notes).length > 0 ? { took: { ...notes } } : {}),
    ...(live.endedMs === undefined ? {} : { endedMs: live.endedMs }),
  }
}

/**
 * Removes the slots this session took over and no longer needs, once its own
 * is written: each of this version's unless it changed since it was read (its
 * session came back), and 0.1.4's by `edit`.
 */
async function clean($: EngineInterface, project: Project, removed: readonly string[], edit: LegacyEdit) {
  const keys = keysOf(live.root)

  for (const id of removed) {
    const key = keys.session(id)
    const current = await $.store.get(key)

    if (isSlot(current) && current.seenMs === project.slots[id]?.seenMs) {
      await $.store.delete(key)
    }
  }

  await editLegacy($, edit, project.legacy.nextId)
}

/**
 * Applies `edit` to 0.1.4's value as it stands just before, its count raised
 * to this session's; with nothing else to change, raises the count alone,
 * while a 0.1.4 session alive here numbers its tasks from it, and only past
 * the count as it was just read (`readCount`). A 0.1.4 session writing in
 * between is the race 0.1.4 always had among its own. A session that hasn't
 * read the project changes nothing there.
 */
async function editLegacy($: EngineInterface, edit: LegacyEdit, readCount = 0) {
  const key = keysOf(live.root).legacy
  const count = await read($, nextId)

  if (key === undefined || !(await isLoaded($)) || (isEmptyEdit(edit) && (!live.hasLegacyPeer || count <= readCount))) {
    return
  }

  const current = legacyOf(await $.store.get(key))
  const edited = editedLegacy(current, edit, count, await $.clock.now())

  if (!isEmptyEdit(edit) || edited.nextId > current.nextId) {
    await $.store.set(key, edited)
  }
}

/**
 * Before a person's press or prompt acts on the tasks: when the slot is two
 * heartbeats old, the session may have slept long enough for another to take
 * its tasks on, so it reads the project, lets them go and redraws. Otherwise
 * it reads nothing: a person waits on this.
 */
async function wake($: EngineInterface) {
  if (live.hasSlot && (await $.clock.now()) - Math.max(live.writtenMs, live.readMs) >= 2 * HEARTBEAT_MS) {
    await beat($)
  }
}

/**
 * Changes the task list and writes the slot, reading nothing (see `wake`).
 * The session's own state is what counts: a write that fails now, the
 * heartbeat makes.
 */
async function change($: EngineInterface, fn: (list: readonly Task[]) => readonly Task[]) {
  await wake($)
  await update($, tasks, fn)
  await awaited($, queued(() => writeOwn($)))
  await refresh($)
}

/**
 * Marks the updates Claude has not heard delivered (every one, or those
 * `isWanted`), in one change of the task list, and resolves them: the path
 * that claims them sends them, and no other finds them waiting meanwhile.
 */
async function claim($: EngineInterface, isWanted: (task: Task) => boolean = () => true): Promise<readonly Task[]> {
  const isDue = (task: Task) => task.update === 'pending' && isWanted(task)
  let due: readonly Task[] = []

  if (!(await read($, tasks)).some(isDue)) {
    return due
  }

  await change($, list => {
    due = list.filter(isDue)

    return list.map(task => (isDue(task) ? { ...task, update: 'delivered' } : task))
  })

  return due
}

/**
 * Keeps the status line in step with the tasks, and closes the pane once
 * nothing is left in it. Resolves whether anything is shown.
 */
async function refresh($: EngineInterface): Promise<boolean> {
  const shown = (await read($, tasks)).filter(isShown)

  $.ui.status(statusOf(shown, live.elsewhere))

  if (shown.length === 0) {
    await $.ui.close({ id: PANE }).catch(() => undefined)
  }

  return shown.length > 0
}

/**
 * Opens the My tasks pane sized to what it holds; `isAsked` when the person
 * asked for it (/my-tasks), so it takes the keyboard. Resolves whether the
 * surface seated it: one opened unasked waits on a narrow terminal.
 */
async function show($: EngineInterface, isAsked: boolean): Promise<boolean> {
  const rows = rowsFor(await paneView($, live), live.columns, MAX_PANE_ROWS)
  live.rows = rows
  // The pane is a view of the tasks: one that can't open costs the user a
  // click on /my-tasks, never the task itself.
  const opened = await $.ui
    .open({ id: PANE, title: PANE_TITLE, rows, ...(isAsked ? { focus: true as const } : {}) })
    .catch(() => ({ isPlaced: false as const }))

  return opened.isPlaced
}

/** What the pane draws from: the session's state, and what only the surface knows. */
async function paneView($: EngineInterface, surface: Pick<PaneView, 'canType' | 'isFocused'>): Promise<PaneView> {
  const field = await read($, editing)

  return {
    shown: (await read($, tasks)).filter(isShown),
    selectedId: await read($, selectedId),
    editing: field,
    draft: field === null ? '' : (live.drafts.get(field.id) ?? ''),
    nowMs: await $.clock.now(),
    sessionId: await $.session.id(),
    isWorking: await read($, isWorking),
    canType: surface.canType,
    isFocused: surface.isFocused,
  }
}

/** Re-sizes the pane to what it holds now, when it is on screen. */
async function fit($: EngineInterface) {
  const panes = await $.ui.panes().catch(() => [])

  if (panes.some(pane => pane.id === PANE && pane.isPlaced)) {
    await show($, false)
  }
}

async function edit($: EngineInterface, id: number, fn: (task: Task) => Task) {
  const nowMs = await $.clock.now()

  await change($, list => list.map(task => (task.id === id ? { ...fn(task), updatedMs: nowMs } : task)))
}

/**
 * Passes on a prompt that carries `due` to Claude, where `isCarried` looks
 * for each; the caller claimed them, so no other path sends them meanwhile.
 * Those that don't enter with it (a hook beneath dropped it or took them
 * out, or it failed) wait again for the next send, and a toast says so, as
 * `onDrop` says for a drop.
 */
async function passOn<R extends PromptSubmitResult>(
  $: EngineInterface,
  due: readonly Task[],
  isCarried: (entered: Entered, task: Task) => boolean,
  onDrop: DropNote,
  pass: () => Promise<R>,
): Promise<R> {
  let back: { lost: readonly Task[]; note: DropNote; reason?: string } | undefined

  try {
    const result = await pass()

    if (result.drop !== undefined) {
      back = { lost: due, note: onDrop, reason: result.drop }
    } else {
      const lost = due.filter(task => !isCarried(result, task))

      if (lost.length > 0) {
        // The prompt entered, and Claude takes a turn on it: sent again as
        // that turn ends, a response a hook beneath always takes out (or
        // rewords at its head) would go round and round. It waits for Send
        // now, as the toast says, or the next prompt.
        lost.forEach(task => live.held.add(updateKeyOf(task)))
        back = { lost, note: 'why', reason: 'a hook took it out of the prompt' }
      }
    }

    return result
  } catch (error) {
    back = { lost: due, note: 'why', reason: error instanceof Error ? error.message : String(error) }

    throw error
  } finally {
    if (back !== undefined) {
      await giveBack($, back.lost.map(task => task.id), back.note, back.reason)
    }
  }
}

/**
 * Whether a prompt that entered carries an update in its words, by how the
 * update opens there (`#5 <title>:`): a hook beneath may rewrite what an
 * answer says (mask a secret in it, say); one that takes the update out, or
 * rewords its head, leaves it to send again, since Claude hearing it twice
 * beats not hearing it.
 */
function inWords(entered: Entered, task: Task): boolean {
  return entered.text.includes(ownHeadOf(task))
}

/** The update a task carries, the same through each send and give-back: a new one changes `updatedMs`. */
function updateKeyOf(task: Task): string {
  return `${task.id}@${task.updatedMs}`
}

/** Whether a prompt that entered carries an update in a digest beside its words (`#5 done: <title>.`), read as `inWords` reads them. */
function inDigest(entered: Entered, task: Task): boolean {
  return (entered.context ?? []).some(block => block.includes(newsHeadOf(task)))
}

/**
 * Gives back updates that never reached Claude, to go with the next send,
 * and says so as `note` says. It never throws: `passOn` keeps the prompt's
 * own error.
 */
async function giveBack($: EngineInterface, ids: readonly number[], note: DropNote, reason?: string) {
  try {
    await undelivered($, ids)
  } catch {
    // `change` sets the session's state before the store and lets a store
    // write fail quietly; nothing else here is expected to throw.
  }

  if (note === 'nothing') {
    return
  }

  const which = numbersOf(ids)
  const why = note === 'why' && reason !== undefined ? `: ${printable(reason, 200).replace(/[.!]+$/, '')}` : ''

  $.ui.toast(`Claude didn't get your response to ${which}${why}. It's saved; press Send now in /my-tasks.`, {
    timeoutMs: 8000,
  })
}

/** Gives back updates marked delivered that never reached Claude: they wait again. */
async function undelivered($: EngineInterface, ids: readonly number[]) {
  await change($, list => list.map(task => (ids.includes(task.id) && task.update === 'delivered' ? { ...task, update: 'pending' } : task)))
}

/** Keeps the selection on a task still open, and drops a field whose task is gone. */
async function settle($: EngineInterface, id: number) {
  live.drafts.delete(id)
  await update($, editing, field => (field?.id === id ? null : field))
  await reselect($)
}

async function reselect($: EngineInterface) {
  const active = (await read($, tasks)).filter(isActive)

  await update($, selectedId, chosen => (active.some(task => task.id === chosen) ? chosen : (active[0]?.id ?? null)))
}

async function select($: EngineInterface, id: number) {
  await update($, selectedId, () => id)
  await update($, editing, field => (field?.id === id ? field : null))
  await fit($)
}

/** The user fulfilled or rejected a task; `how` says when Claude hears of it. */
async function resolve($: EngineInterface, id: number, patch: Pick<Task, 'state'> & Partial<Task>, how: How) {
  await edit($, id, task => ({ ...task, ...patch, update: 'pending' }))
  await settle($, id)

  if (how === 'now' || (how === 'auto' && !working())) {
    sendSoon($)
  }
}

async function answer($: EngineInterface, id: number, text: string, how: How, isSecretOk = false) {
  const value = text.trim()

  if (value === '') {
    $.ui.toast('Type an answer first, or press Cancel.')
    return
  }

  if (!isSecretOk && looksSecret(value)) {
    await update($, editing, (): Editing => ({ id, field: 'answer', held: value }))
    return
  }

  await resolve($, id, { state: 'done', answer: value }, how)
}

async function startEditing($: EngineInterface, id: number, field: Editing['field']) {
  await update($, selectedId, () => id)
  await update($, editing, (): Editing => ({ id, field }))
  await fit($)

  // A field the pane can't focus (it doesn't hold the keyboard) is still a click away.
  void $.ui.focus({ requestId: PANE, key: field }).then(undefined, () => undefined)
}

async function stopEditing($: EngineInterface) {
  await update($, editing, () => null)
  await fit($)
}

/** Moves a long answer into the prompt box, where the real editor takes pastes and lines. */
async function longAnswer($: EngineInterface, id: number) {
  const box = await $.prompt.read()
  const draft = live.drafts.get(id) ?? ''
  const text = bridgeOf(id) + [draft, box.text].filter(part => part.trim() !== '').join('\n')
  const filled = await $.prompt.fill({ text, mode: 'replace' })

  if (!filled.isFilled) {
    $.ui.toast("Couldn't open the prompt box for your answer; type it here instead.")
    return
  }

  live.drafts.delete(id)
  await update($, editing, () => null)
  $.ui.toast('Write your answer in the prompt box (Esc gets you there), then press Enter.', {
    timeoutMs: 8000,
  })
}

function sendNow($: EngineInterface) {
  live.batch?.cancel()
  live.batch = null
  void send($)
}

function sendSoon($: EngineInterface) {
  live.batch?.cancel()
  live.batch = $.clock.after(BATCH_MS, () => {
    live.batch = null
    void send($)
  })
}

/**
 * Hands Claude every update it has not heard: a turn of its own while it is
 * idle, a row its running turn reads at the next step while it works.
 * `isTurnOver`: sent as main's turn ends, when Claude is idle whatever the
 * engine's last word on it was.
 */
async function send($: EngineInterface, isTurnOver = false) {
  // What the process holds is the folder's it leaves: its Claude hears it there.
  if (live.moving > 0) {
    return
  }

  await wake($)
  const due = await claim($)

  if (due.length === 0) {
    return
  }

  const text = messageOf(due)
  const ids = due.map(task => task.id)
  const which = numbersOf(ids)

  if (isTurnOver || !working()) {
    await passOn($, due, inWords, 'why', () => $.prompt.submit({ text, asUser: true })).catch(() => undefined)
    return
  }

  const isTaken = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }).then(
    appended => appended.deny === undefined,
    () => false,
  )

  if (!isTaken) {
    await undelivered($, ids)

    // The turn ended while the row was being refused: they go now.
    if (!working()) {
      void send($, true)
      return
    }

    live.isSendingAtEnd = true
    $.ui.toast(`Claude gets your response to ${which} when it finishes this turn.`)
    return
  }

  live.isUnread = true

  try {
    await $.session.append({ message: { type: 'system', content: [{ type: 'text', text: `Sent your response to ${which} to Claude` }] } })
  } catch {
    // The notice is for the user's eyes only; Claude has the answer either way.
  }
}
