import type { Task, TaskRef, Took } from '../types'
import { isShown } from './tasks'

/** How often a live session says so in the project's store. */
export const HEARTBEAT_MS = 60_000

/** A session not heard from for this long is gone: its tasks are free to adopt. */
export const STALE_MS = 3 * 60_000

/** How long a note of tasks taken from a quiet session waits for it to come back. */
export const TAKEN_MS = 30 * 24 * 60 * 60_000

/**
 * One session's part of a project: its tasks, when it was last alive, the
 * next task number as it counts them, and the tasks it took on from others.
 */
export type Slot = {
  tasks: Task[]
  seenMs: number
  /** Set when the session ended: its tasks wait for the next session here. */
  endedMs?: number
  /** Absent from a slot 0.1.4 wrote. */
  nextId?: number
  took?: Record<string, Took>
}

/** 0.1.4's note: the numbers of a quiet session's tasks another session took on. */
export type Note = { ids: number[]; atMs: number }

/**
 * 0.1.4's layout: the whole project in one value, which each of its sessions
 * reads and writes back whole. This version reads it, and changes it only
 * where it takes on a 0.1.4 session's tasks.
 */
export type Legacy = { nextId: number; sessions: Record<string, Slot>; taken: Record<string, Note> }

/**
 * A project as the store holds it: each session's slot by session id, and
 * 0.1.4's value. Gathered from them as read: every slot of both (a session in
 * both writes its own key now), its notes less what was taken back since, and
 * the tasks other sessions noted taking on from each, by its id.
 */
export type Project = {
  slots: Record<string, Slot>
  legacy: Legacy
  all: Record<string, Slot>
  tookFrom: Record<string, TaskRef[]>
}

/** A change to 0.1.4's value: slots taken out, notes left for their quiet sessions, and this session's note read. */
export type LegacyEdit = { removed: string[]; taken: Record<string, Note>; read?: string }

/** The store's longest key, in UTF-16 code units: the engine checks a key's `length`. */
const MAX_KEY = 256

/** Room kept in a session's key for its id, which is a UUID (36 characters). */
const MAX_SESSION_ID = 64

/**
 * Where a project sits in the store. `$.store` writes one key at a time,
 * under a lock, and has no compare-and-set: so each session's slot has a key
 * of its own, which only that session writes, and no session's write can put
 * back a stale copy of another's. A root too long for the store's keys goes
 * by its hash. `legacy` is 0.1.4's key, absent when it is too long to read.
 */
export function keysOf(root: string) {
  const legacy = `tasks:${root}`
  const name = `${legacy}#session:`.length + MAX_SESSION_ID <= MAX_KEY ? root : `#${hashOf(root)}`
  const prefix = `tasks:${name}#session:`

  return {
    legacy: legacy.length <= MAX_KEY ? legacy : undefined,
    prefix,
    session: (id: string) => `${prefix}${id}`,
  }
}

/** 53 bits of `text`'s hash (cyrb53), in base 36. */
function hashOf(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)

  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/** Whether a stored value is an object with an array under `list` and a number under `count`: a slot's shape, and a note's. */
function isShaped(value: unknown, list: string, count: string): value is Record<string, unknown> {
  const record = value as Record<string, unknown> | null

  return record !== null && typeof record === 'object' && Array.isArray(record[list]) && typeof record[count] === 'number'
}

/** Whether a stored value is a slot: anything else under a slot's key is skipped. */
export function isSlot(value: unknown): value is Slot {
  return isShaped(value, 'tasks', 'seenMs')
}

function isNote(value: unknown): value is Note {
  return isShaped(value, 'ids', 'atMs')
}

/** Whether a stored value is a task, as the pane and the project's reckoning read one. */
function isTask(value: unknown): value is Task {
  const task = value as Record<string, unknown> | null
  const isText = (key: string) => typeof task?.[key] === 'string'
  const options = task?.['options']

  return (
    task !== null &&
    typeof task === 'object' &&
    ['id', 'createdMs', 'updatedMs'].every(key => typeof task[key] === 'number') &&
    ['title', 'why', 'kind', 'state', 'update', 'sessionId'].every(isText) &&
    ['doneWhen', 'answer', 'reason'].every(key => task[key] === undefined || isText(key)) &&
    (options === undefined || (Array.isArray(options) && options.every(option => typeof option === 'string')))
  )
}

function isRef(value: unknown): value is TaskRef {
  const ref = value as Partial<TaskRef> | null

  return ref !== null && typeof ref === 'object' && typeof ref.id === 'number' && typeof ref.createdMs === 'number'
}

/** The entries of a stored record as `of` reads them; one it reads as nothing is skipped. */
function entriesOf<T>(raw: unknown, of: (value: unknown) => T | undefined): Record<string, T> {
  const read: Record<string, T> = {}

  for (const [key, value] of raw !== null && typeof raw === 'object' ? Object.entries(raw) : []) {
    const entry = of(value)

    if (entry !== undefined) {
      read[key] = entry
    }
  }

  return read
}

/** A stored value as a note of tasks taken, less what in it isn't one; nothing when it isn't a note. */
function tookIn(value: unknown): Took | undefined {
  if (!isShaped(value, 'tasks', 'atMs')) {
    return undefined
  }

  return { tasks: (value.tasks as unknown[]).filter(isRef), atMs: value.atMs as number, ...(value.isEnded === true ? { isEnded: true } : {}) }
}

/** A stored value as a slot, less what in it isn't a task, a count or a note; nothing when it isn't a slot. */
function slotIn(value: unknown): Slot | undefined {
  if (!isSlot(value)) {
    return undefined
  }

  return {
    tasks: value.tasks.filter(isTask),
    seenMs: value.seenMs,
    ...(typeof value.endedMs === 'number' ? { endedMs: value.endedMs } : {}),
    ...(typeof value.nextId === 'number' ? { nextId: value.nextId } : {}),
    ...(value.took === undefined ? {} : { took: entriesOf(value.took, tookIn) }),
  }
}

/** Reads 0.1.4's value, its first layout (one list for the project) included. */
export function legacyOf(raw: unknown): Legacy {
  const value = (raw ?? {}) as { nextId?: unknown; sessions?: unknown; tasks?: unknown; taken?: unknown }
  const nextId = typeof value.nextId === 'number' ? value.nextId : 1
  const taken = entriesOf(value.taken, note => (isNote(note) ? note : undefined))

  if (value.sessions !== null && typeof value.sessions === 'object') {
    return { nextId, sessions: entriesOf(value.sessions, slotIn), taken }
  }

  // The first layout kept one list per project: its tasks belong to sessions
  // that have ended.
  const sessions: Record<string, Slot> = {}

  for (const task of Array.isArray(value.tasks) ? value.tasks.filter(isTask) : []) {
    const slot = (sessions[task.sessionId] ??= { tasks: [], seenMs: 0, endedMs: 0 })
    slot.tasks.push(task)
  }

  return { nextId, sessions, taken: {} }
}

/**
 * A project from the store's values, by key. A session id has no `#`: a key
 * past the prefix that has one is another root's, whose path goes on with
 * `#session:`.
 */
export function projectOf(root: string, values: Readonly<Record<string, unknown>>): Project {
  const keys = keysOf(root)
  const slots: Record<string, Slot> = {}

  for (const [key, value] of Object.entries(values)) {
    const id = key.startsWith(keys.prefix) ? key.slice(keys.prefix.length) : '#'
    const slot = id.includes('#') ? undefined : slotIn(value)

    if (slot !== undefined) {
      slots[id] = slot
    }
  }

  return gathered(slots, legacyOf(keys.legacy === undefined ? undefined : values[keys.legacy]))
}

/**
 * `project` with these sessions' slots as given: the process's own account
 * of them, which the store may not have yet.
 */
export function withSlots(project: Project, slots: Readonly<Record<string, Slot>>): Project {
  return gathered({ ...project.slots, ...slots }, project.legacy)
}

/** A project from its slots and 0.1.4's value, with what is gathered from them. */
function gathered(slots: Record<string, Slot>, legacy: Legacy): Project {
  const stored = { ...legacy.sessions, ...slots }
  const all: Record<string, Slot> = {}
  const tookFrom: Record<string, TaskRef[]> = {}

  for (const [other, slot] of Object.entries(stored)) {
    const notes = Object.entries(slot.took ?? {}).map(([id, note]) => [id, stillTaken(stored, other, id, note)] as const)
    const took = slot.took === undefined ? undefined : Object.fromEntries(notes.filter(([, note]) => note.tasks.length > 0))
    all[other] = took === undefined ? slot : { ...slot, took }

    for (const [id, note] of Object.entries(took ?? {})) {
      if (id !== other) {
        tookFrom[id] = [...(tookFrom[id] ?? []), ...note.tasks]
      }
    }
  }

  return { slots, legacy, all, tookFrom }
}

/**
 * `note`, of the tasks session `taker` took on from session `from`, less
 * those `from` took back since: a session resumed after it ended, say, that
 * takes its tasks back from a quiet one that had taken them. Its later note
 * outweighs the older one, which the quiet one drops if it comes back.
 */
function stillTaken(all: Readonly<Record<string, Slot>>, taker: string, from: string, note: Took): Took {
  const back = all[from]?.took?.[taker]

  if (back === undefined || back.atMs <= note.atMs) {
    return note
  }

  return { ...note, tasks: without(note.tasks, back.tasks) }
}

const refOf = (task: Task): TaskRef => ({ id: task.id, createdMs: task.createdMs })

const isSameRef = (one: TaskRef, other: TaskRef) => one.id === other.id && one.createdMs === other.createdMs

/** Whether `one` and `other` are one task: a number alone can name two, drawn by two sessions at once. */
export const isSameTask = (one: Task, other: Task) => one.sessionId === other.sessionId && isSameRef(one, other)

/** The refs of `refs` that `others` doesn't name. */
const without = (refs: readonly TaskRef[], others: readonly TaskRef[]) => refs.filter(ref => !others.some(other => isSameRef(other, ref)))

const isRefTo = (task: Task) => (ref: TaskRef) => isSameRef(ref, task)

/**
 * Whether another session took `task` on from session `id`: noted in the
 * taker's slot, or in a 0.1.4 note, which names numbers only.
 */
export function isTakenFrom(project: Project, id: string, task: Task): boolean {
  return project.legacy.taken[id]?.ids.includes(task.id) === true || project.tookFrom[id]?.some(isRefTo(task)) === true
}

/** The tasks in session `id`'s slot that no other session took on. */
function heldIn(project: Project, id: string, slot: Slot): Task[] {
  return slot.tasks.filter(task => isShown(task) && !isTakenFrom(project, id, task))
}

/** Whether a session's tasks are free for another to take on: it ended, or went quiet. */
export function isGone(slot: Slot, nowMs: number): boolean {
  return slot.endedMs !== undefined || nowMs - slot.seenMs > STALE_MS
}

/**
 * The next task number: past every number a session of the project has
 * drawn. Each slot carries its session's count, and a slot leaves the store
 * only once a later one carries it, so this never goes back.
 */
export function floorOf(project: Project): number {
  const slots = Object.values(project.all)

  return Math.max(project.legacy.nextId, ...slots.map(slot => slot.nextId ?? 1), ...slots.flatMap(slot => slot.tasks.map(task => task.id + 1)))
}

/** Whether a 0.1.4 session other than `sessionId` is alive in the project: it reads 0.1.4's value only. */
export function hasLegacyPeer(project: Project, sessionId: string, nowMs: number): boolean {
  return Object.entries(project.legacy.sessions).some(([id, slot]) => id !== sessionId && !isGone(slot, nowMs))
}

/** How many tasks wait in the project's other live sessions. */
export function elsewhereIn(project: Project, sessionId: string, nowMs: number): number {
  return Object.entries(project.all)
    .filter(([id, slot]) => id !== sessionId && !isGone(slot, nowMs))
    .reduce((sum, [id, slot]) => sum + heldIn(project, id, slot).length, 0)
}

/** One note of what was taken from a session, from two: the tasks of both, the later time, ended only if both say so. */
function merged(one: Took | undefined, other: Took): Took {
  if (one === undefined) {
    return other
  }

  const tasks = [...one.tasks, ...without(other.tasks, one.tasks)]
  const isEnded = one.isEnded === true && other.isEnded === true

  return { tasks, atMs: Math.max(one.atMs, other.atMs), ...(isEnded ? { isEnded } : {}) }
}

/**
 * Carries a slot's notes of what its session took into `into`, but for a
 * note of tasks taken from `sessionId`: those it holds itself again.
 */
function carry(into: Record<string, Took>, notes: Slot['took'], sessionId: string) {
  for (const [from, note] of Object.entries(notes ?? {})) {
    if (from !== sessionId) {
      into[from] = merged(into[from], note)
    }
  }
}

/**
 * The session's own leftovers in 0.1.4's value, to take out: its slot, from
 * before a hot reload into this version, and a note another session left it.
 */
function ownLegacy(project: Project, sessionId: string): LegacyEdit {
  return {
    removed: sessionId in project.legacy.sessions ? [sessionId] : [],
    taken: {},
    ...(sessionId in project.legacy.taken ? { read: sessionId } : {}),
  }
}

/**
 * Takes a slot that leaves the store out of 0.1.4's value too, where a 0.1.4
 * session's write put back the copy of it from before its session came to
 * this version: with the slot gone, the copy would pass for it.
 */
function dropLegacyCopy(project: Project, id: string, legacy: LegacyEdit) {
  if (id in project.legacy.sessions && !legacy.removed.includes(id)) {
    legacy.removed.push(id)
  }
}

/** What a session joining a project takes on, and what it leaves for the store to clean. */
export type Adoption = {
  /** Its own tasks (a resumed session) and those of sessions that ended or went quiet. */
  adopted: Task[]
  /** Those it numbered anew, another having drawn their numbers too: each as it was, with its new number. */
  renumbered: { task: Task; id: number }[]
  /**
   * Its notes of what it took: each kept in its slot, so a crash anywhere
   * after leaves no task twice. Until that write lands, a session it took
   * from that comes back keeps the tasks too, and lets them go once it reads
   * the note.
   */
  took: Record<string, Took>
  nextId: number
  /** This version's slots to remove once its own is written: ended, or holding nothing. */
  removed: string[]
  legacy: LegacyEdit
}

/**
 * Takes on, for `sessionId`, its own slot (a resumed session) and every slot
 * of a session that is gone. Live sessions keep theirs, and so does a quiet
 * one with tasks: if it comes back, it reads the note and lets them go. An
 * ended session's slot is removed once the taker's is written, its notes
 * carried over; so is an empty slot, its count carried in the taker's. Each
 * takes with it any copy of it that 0.1.4's value still has.
 *
 * Two sessions assigning at the same moment can draw one number (the store
 * has no way to reserve one): where their tasks meet here, the session's own
 * keep theirs, the numbers its Claude knows, then those of `holder`, the
 * session whose tasks the process holds (the one it left with /clear or a
 * resume in place), the numbers the user knows, and a later one gets a new one.
 * So does one with a number in `known`, the session's own tasks that it is
 * done with, in no slot, or in a 0.1.4 note of tasks taken from it: a copy
 * of that note a 0.1.4 session's write puts back would take it again.
 *
 * A session taking the project on as it ends (`isEnding`) takes nothing from
 * a quiet one, which may come back: the next session to start takes it on.
 */
export function adopt(project: Project, sessionId: string, nowMs: number, known: readonly number[] = [], isEnding = false, holder: string | null = null): Adoption {
  const all = project.all
  const rank = (id: string) => (id === sessionId ? 0 : id === holder ? 1 : 2)
  const ids = Object.keys(all).sort((a, b) => rank(a) - rank(b))
  const adopted: Task[] = []
  const renumbered: Adoption['renumbered'] = []
  const took: Record<string, Took> = {}
  const removed: string[] = []
  const legacy = ownLegacy(project, sessionId)
  // A 0.1.4 note's numbers were drawn from the project's count: a new number is past them.
  const drawn = [...known, ...(project.legacy.taken[sessionId]?.ids ?? [])]
  let nextId = Math.max(floorOf(project), ...known.map(id => id + 1))

  for (const id of ids) {
    const slot = all[id]!

    if (id !== sessionId && (!isGone(slot, nowMs) || (isEnding && slot.endedMs === undefined))) {
      continue
    }

    const held = heldIn(project, id, slot)

    for (const task of held) {
      if (adopted.some(one => one.id === task.id) || drawn.includes(task.id)) {
        renumbered.push({ task, id: nextId })
        adopted.push({ ...task, id: nextId++ })
      } else {
        adopted.push(task)
      }
    }

    if (id === sessionId) {
      // Resumed: what it took before, it still holds.
      carry(took, slot.took, sessionId)
      continue
    }

    const isEnded = slot.endedMs !== undefined

    if (held.length > 0) {
      took[id] = merged(took[id], { tasks: held.map(refOf), atMs: nowMs, ...(isEnded ? { isEnded } : {}) })
    }

    if (id in project.slots) {
      if (isEnded || slot.tasks.length === 0) {
        removed.push(id)
        carry(took, slot.took, sessionId)
        dropLegacyCopy(project, id, legacy)
      }

      continue
    }

    // A 0.1.4 session's: out of its value, with a note it reads if it comes
    // back. The note names every task it showed, not just those taken now:
    // it reads no note of this version's, and one left by whoever took the
    // rest may have gone with a 0.1.4 session's write.
    legacy.removed.push(id)

    if (!isEnded && slot.tasks.length > 0) {
      legacy.taken[id] = { ids: slot.tasks.filter(isShown).map(task => task.id), atMs: nowMs }
    }
  }

  adopted.sort((a, b) => a.id - b.id)

  return { adopted, renumbered, took, nextId, removed, legacy }
}

/**
 * Session `sessionId`'s notes of what it took, less those no longer needed:
 * the session it took from let go of the tasks or took them back, or it
 * ended and its slot is gone, or the note is a month old. A slot left
 * behind (an ended session's, whose removal didn't happen, or a quiet one's
 * that never came back in a month) is removed now, with any copy of it in
 * 0.1.4's value, its note kept until it is gone and its own notes carried
 * over; so are the session's own leftovers in 0.1.4's value.
 */
export function prune(
  project: Project,
  sessionId: string,
  took: Readonly<Record<string, Took>>,
  nowMs: number,
): { took: Record<string, Took>; removed: string[]; legacy: LegacyEdit } {
  const kept: Record<string, Took> = {}
  const removed: string[] = []
  const legacy = ownLegacy(project, sessionId)
  const keep = (id: string, note: Took) => {
    kept[id] = merged(kept[id], note)
  }

  for (const [id, mine] of Object.entries(took)) {
    const note = stillTaken(project.all, sessionId, id, mine)
    const slot = project.all[id]
    const isExpired = nowMs - note.atMs > TAKEN_MS

    if (note.tasks.length === 0) {
      continue
    }

    if (slot === undefined) {
      // A quiet session may come back with its tasks in memory: the note
      // waits for it. Once its slot is gone, nothing tells whether it ended
      // since: a process that goes on after /clear takes on what it held,
      // but for what a note names.
      if (note.isEnded !== true && !isExpired) {
        keep(id, note)
      }

      continue
    }

    const has = (task: Task) => note.tasks.some(isRefTo(task))

    if (slot.seenMs > note.atMs && !slot.tasks.some(has)) {
      continue
    }

    if (slot.seenMs <= note.atMs && (note.isEnded === true || isExpired || !(id in project.slots))) {
      if (id in project.slots) {
        removed.push(id)
        dropLegacyCopy(project, id, legacy)

        // What it took on from others, it may hold yet: its notes go on here.
        carry(kept, slot.took, sessionId)
      } else {
        legacy.removed.push(id)

        if (note.isEnded !== true) {
          legacy.taken[id] = { ids: note.tasks.map(ref => ref.id), atMs: note.atMs }
        }
      }

      keep(id, note)
      continue
    }

    if (!isExpired) {
      keep(id, note)
    }
  }

  return { took: kept, removed, legacy }
}

export function isEmptyEdit(edit: LegacyEdit): boolean {
  return edit.removed.length === 0 && Object.keys(edit.taken).length === 0 && edit.read === undefined
}

/** `edit` applied to 0.1.4's value as it stands now, the count raised to `nextId`; notes a month old leave. */
export function editedLegacy(current: Legacy, edit: LegacyEdit, nextId: number, nowMs: number): Legacy {
  const sessions = { ...current.sessions }
  const taken: Record<string, Note> = {}

  for (const id of edit.removed) {
    delete sessions[id]
  }

  for (const [id, note] of Object.entries(current.taken)) {
    if (id !== edit.read && nowMs - note.atMs < TAKEN_MS) {
      taken[id] = note
    }
  }

  for (const [id, note] of Object.entries(edit.taken)) {
    taken[id] = { ids: [...new Set([...(taken[id]?.ids ?? []), ...note.ids])], atMs: note.atMs }
  }

  return { nextId: Math.max(current.nextId, nextId), sessions, taken }
}
