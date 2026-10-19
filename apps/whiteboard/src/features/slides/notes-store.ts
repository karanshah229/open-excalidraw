import { boardHistoryStore } from '@agentic-whiteboard/storage'
import { historyEditingState, assertHistoryMutationAllowed } from '../history/history-editing-gate'
import { projectCall } from '../sharing/project-service'

export const MAX_NOTE_LENGTH = 20000
export type NoteDraft = { key: string; text: string; revision: number; dirty: boolean; mutationId: string; generation?: number }
export type RemoteNote = { text: string; revision: number; conflict: boolean; updatedAt: string | null }
let database: Promise<IDBDatabase> | undefined
function openDatabase() {
  return (database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('agentic-whiteboard:slide-notes', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('notes', { keyPath: 'key' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => {
      database = undefined
      reject(request.error)
    }
  }))
}
export function noteKey(identity: string, boardId: string, slideId: string) {
  return `${identity}:${boardId}:${slideId}`
}
export async function readNoteDraft(key: string): Promise<NoteDraft | undefined> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const request = db.transaction('notes').objectStore('notes').get(key)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
export async function writeNoteDraft(draft: NoteDraft, expectedEpoch?: number) {
  const boardId = draft.key.split(':')[1]
  const epoch = historyEditingState(boardId).epoch
  assertHistoryMutationAllowed(boardId, expectedEpoch)
  if (draft.generation !== undefined && historyEditingState(boardId).generation !== undefined && draft.generation !== historyEditingState(boardId).generation) throw new Error('BOARD_GENERATION_CONFLICT')
  const db = await openDatabase()
  assertHistoryMutationAllowed(boardId, epoch)
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('notes', 'readwrite')
    transaction.objectStore('notes').put(draft)
    transaction.oncomplete = () => resolve()
    transaction.onerror = transaction.onabort = () => reject(transaction.error)
  })
}
/** Acknowledgement cannot replace typing done while the network request was pending. */
export async function acknowledgeNote(draft: NoteDraft, remote: RemoteNote): Promise<NoteDraft> {
  const boardId = draft.key.split(':')[1]
  const epoch = historyEditingState(boardId).epoch
  assertHistoryMutationAllowed(boardId)
  const db = await openDatabase()
  assertHistoryMutationAllowed(boardId, epoch)
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('notes', 'readwrite'),
      store = transaction.objectStore('notes')
    let next: NoteDraft
    const request = store.get(draft.key)
    request.onsuccess = () => {
      const latest: NoteDraft = request.result ?? draft
      next =
        latest.mutationId === draft.mutationId
          ? { ...latest, text: remote.text, revision: remote.revision, dirty: false }
          : { ...latest, revision: remote.revision }
      store.put(next)
    }
    transaction.oncomplete = () => resolve(next)
    transaction.onerror = transaction.onabort = () => reject(transaction.error)
  })
}
export function callNote(
  operation: 'read' | 'write',
  boardId: string,
  projectId: string,
  slideId: string,
  draft?: NoteDraft,
) {
  if (operation === 'write') {
    assertHistoryMutationAllowed(boardId)
    const generation = historyEditingState(boardId).generation
    if (generation !== undefined && (draft?.generation ?? 1) !== generation) throw new Error('BOARD_GENERATION_CONFLICT')
  }
  const gate = historyEditingState(boardId)
  return projectCall<RemoteNote>('slideNotes', {
    operation,
    boardId,
    projectId,
    slideId,
    ...(draft ? { text: draft.text, revision: draft.revision, mutationId: draft.mutationId, ...(gate.generation !== undefined ? { generation: gate.generation, expectedFence: gate.restoreFence ?? 0 } : {}) } : {}),
  })
}

/** Notes remain outside elements, including when a slide is duplicated. */
export async function copySlideNotes(
  context: { identity: string; boardId: string; projectId: string; cloud: boolean },
  sourceId: string,
  targetId: string,
) {
  const { identity, boardId, projectId, cloud } = context
  const epoch = historyEditingState(boardId).epoch
  assertHistoryMutationAllowed(boardId)
  const original = await readNoteDraft(noteKey(identity, boardId, sourceId))
  const remote = cloud && navigator.onLine ? await callNote('read', boardId, projectId, sourceId) : undefined
  const text = original?.dirty ? original.text : (remote?.text ?? original?.text)
  if (!text) return
  assertHistoryMutationAllowed(boardId, epoch)
  const draft: NoteDraft = {
    key: noteKey(identity, boardId, targetId),
    text,
    revision: 0,
    dirty: true,
    mutationId: crypto.randomUUID(),
    generation: historyEditingState(boardId).generation,
  }
  await writeNoteDraft(draft, epoch)
  assertHistoryMutationAllowed(boardId, epoch)
  const current = await boardHistoryStore.getCommittedContent(boardId)
  if (!current) throw new Error('Load the complete board before copying notes.')
  assertHistoryMutationAllowed(boardId, epoch)
  await boardHistoryStore.saveNotes(boardId, { ...current.notes, [targetId]: text }, { changedFields: { notes: [targetId] }, fieldBases: { notes: { [targetId]: 0 } }, ...(historyEditingState(boardId).restoreFence !== undefined ? { expectedFence: historyEditingState(boardId).restoreFence } : {}) })
  assertHistoryMutationAllowed(boardId, epoch)
  window.dispatchEvent(new CustomEvent('board-history-local-save', { detail: { boardId } }))
  if (cloud && navigator.onLine) {
    const saved = await callNote('write', boardId, projectId, targetId, draft)
    assertHistoryMutationAllowed(boardId, epoch)
    if (saved.conflict) throw new Error('Note copy conflict')
    await acknowledgeNote(draft, saved)
  }
}

/** Compare-and-swap protects typing performed while another client awaits a note write. */
export async function replaceNoteDraft(key: string, expectedMutationId: string | undefined, next: NoteDraft) {
  const db = await openDatabase()
  return new Promise<boolean>((resolve, reject) => {
    const transaction = db.transaction('notes', 'readwrite'),
      store = transaction.objectStore('notes')
    let replaced = false
    const request = store.get(key)
    request.onsuccess = () => {
      const current = request.result as NoteDraft | undefined
      if (current?.mutationId !== expectedMutationId) return
      store.put(next)
      replaced = true
    }
    transaction.oncomplete = () => resolve(replaced)
    transaction.onerror = transaction.onabort = () => reject(transaction.error)
  })
}

/** Include hidden slides: a dirty draft must not escape restore confirmation. */
export async function hasDirtyBoardNotes(identity: string, boardId: string): Promise<boolean> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('notes')
    const request = transaction.objectStore('notes').openCursor()
    const prefix = `${identity}:${boardId}:`
    let dirty = false
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return
      if (cursor.key.toString().startsWith(prefix) && (cursor.value as NoteDraft).dirty) dirty = true
      cursor.continue()
    }
    transaction.oncomplete = () => resolve(dirty)
    transaction.onerror = transaction.onabort = () => reject(transaction.error)
  })
}

/** Called only after complete replacement hydration; old drafts may not survive into the new universe. */
export async function replaceBoardNoteDrafts(identity: string, boardId: string, notes: Record<string, string>, revisions: Record<string, number> = {}) {
  const db = await openDatabase()
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('notes', 'readwrite')
    const store = transaction.objectStore('notes')
    const prefix = `${identity}:${boardId}:`
    const request = store.openCursor()
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) {
        for (const [slideId, text] of Object.entries(notes)) store.put({ key: noteKey(identity, boardId, slideId), text, revision: revisions[slideId] ?? 0, dirty: false, generation: historyEditingState(boardId).generation, mutationId: crypto.randomUUID() } satisfies NoteDraft)
        return
      }
      if (cursor.key.toString().startsWith(prefix)) cursor.delete()
      cursor.continue()
    }
    transaction.oncomplete = () => resolve()
    transaction.onerror = transaction.onabort = () => reject(transaction.error)
  })
}
