/**
 * What Claude needs from the user: something done (`do`), an answer in
 * their own words (`answer`), or one of a few options (`choose`).
 */
export type TaskKind = 'do' | 'answer' | 'choose'

/**
 * Where a task stands: waiting for the user (`open`), fulfilled (`done`),
 * turned down (`rejected`), or taken back by Claude (`withdrawn`).
 */
export type TaskState = 'open' | 'done' | 'rejected' | 'withdrawn'

/**
 * Whether Claude has heard of the user's latest move on the task: nothing
 * to tell (`none`), told nothing yet (`pending`), or told (`delivered`).
 */
export type TaskUpdate = 'none' | 'pending' | 'delivered'

/** A task Claude gave the user. */
export type Task = {
  /** Counts up per project: #1, #2, … */
  id: number
  title: string
  why: string
  doneWhen?: string
  kind: TaskKind
  options?: readonly string[]
  state: TaskState
  /** The user's answer, or the option they chose. */
  answer?: string
  /** Why the user rejected it, or why Claude withdrew it. */
  reason?: string
  update: TaskUpdate
  /** The session that assigned it. */
  sessionId: string
  createdMs: number
  updatedMs: number
}

/**
 * A task as the session that held it numbered it, and when it was assigned:
 * where two sessions drew one number, that tells their tasks apart.
 */
export type TaskRef = { id: number; createdMs: number }

/**
 * The tasks one session took on from another that had ended or gone quiet,
 * as that session numbered them, and when. `isEnded`: it had ended, so it
 * won't come back for them.
 */
export type Took = { tasks: readonly TaskRef[]; atMs: number; isEnded?: boolean }

/**
 * The selected task's field, when the pane shows one in place of its
 * buttons: an answer, or a reason for rejecting. `held` is an answer held
 * back because it looks like a secret.
 */
export type Editing = {
  id: number
  field: 'answer' | 'reason'
  held?: string
}

declare module 'claude-code' {
  interface PluginState {
    'human-in-the-loop': {
      tasks: readonly Task[]
      nextId: number
      /** The tasks this session took on from others, by their session id. */
      took: Readonly<Record<string, Took>>
      selectedId: number | null
      editing: Editing | null
      loadedFor: string | null
      isWorking: boolean
      /** The remote clients attached, by surface: two phones are two clients on one. */
      clients: Readonly<Partial<Record<RenderSurface, readonly string[]>>>
    }
  }
}
