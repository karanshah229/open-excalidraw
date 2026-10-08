import { projectCall } from '../sharing/project-service'

export const MAX_NOTE_LENGTH = 20000
export type NoteDraft = { key: string; text: string; revision: number; dirty: boolean; mutationId: string }
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
export async function writeNoteDraft(draft: NoteDraft) {
  const db = await openDatabase()
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('notes', 'readwrite')
    transaction.objectStore('notes').put(draft)
    transaction.oncomplete = () => resolve()
    transaction.onerror = transaction.onabort = () => reject(transaction.error)
  })
}
/** Acknowledgement cannot replace typing done while the network request was pending. */
export async function acknowledgeNote(draft: NoteDraft, remote: RemoteNote): Promise<NoteDraft> {
  const db = await openDatabase()
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
  return projectCall<RemoteNote>('slideNotes', {
    operation,
    boardId,
    projectId,
    slideId,
    ...(draft ? { text: draft.text, revision: draft.revision, mutationId: draft.mutationId } : {}),
  })
}

/** Notes remain outside elements, including when a slide is duplicated. */
export async function copySlideNotes(
  context: { identity: string; boardId: string; projectId: string; cloud: boolean },
  sourceId: string,
  targetId: string,
) {
  const { identity, boardId, projectId, cloud } = context
  const original = await readNoteDraft(noteKey(identity, boardId, sourceId))
  const remote = cloud && navigator.onLine ? await callNote('read', boardId, projectId, sourceId) : undefined
  const text = original?.dirty ? original.text : (remote?.text ?? original?.text)
  if (!text) return
  const draft: NoteDraft = {
    key: noteKey(identity, boardId, targetId),
    text,
    revision: 0,
    dirty: true,
    mutationId: crypto.randomUUID(),
  }
  await writeNoteDraft(draft)
  if (cloud && navigator.onLine) {
    const saved = await callNote('write', boardId, projectId, targetId, draft)
    if (saved.conflict) throw new Error('Note copy conflict')
    await acknowledgeNote(draft, saved)
  }
}
