import { randomUUID, createHash } from 'node:crypto'
import { getFirestore, type Transaction } from 'firebase-admin/firestore'
import { HttpsError } from 'firebase-functions/v2/https'

export type NoteSnapshot = Record<string, { text: string; revision: number; updatedAt: string | null }>
const PAGE_BYTES = 200 * 1024
export async function loadNoteSnapshot(
  boardId: string,
  revisionId: string | null,
  tx?: Transaction,
): Promise<NoteSnapshot> {
  const db = getFirestore()
  if (!revisionId) {
    const query = db.collection(`slideNotes/${boardId}/notes`)
    const notes = tx ? await tx.get(query) : await query.get()
    return Object.fromEntries(
      notes.docs.map((note) => [
        note.id,
        {
          text: note.data().text ?? '',
          revision: note.data().revision ?? 0,
          updatedAt: note.data().updatedAt ?? null,
        },
      ]),
    )
  }
  const ref = db.doc(`boardScenes/${boardId}/noteRevisions/${revisionId}`)
  const root = (tx ? await tx.get(ref) : await ref.get()).data()
  if (!root || !Number.isInteger(root.pageCount) || root.pageCount > 100)
    throw new HttpsError('failed-precondition', 'Missing protected note manifest.')
  const result: NoteSnapshot = Object.create(null)
  for (let slot = 0; slot < root.pageCount; slot++) {
    const page = db.doc(`${ref.path}/pages/${String(slot).padStart(6, '0')}`)
    const data = (tx ? await tx.get(page) : await page.get()).data()
    if (!data) throw new HttpsError('failed-precondition', 'Missing protected note page.')
    let notes = data.notes
    if (!notes && data.chunkId) {
      const chunkRef = db.doc(`boardScenes/${boardId}/noteChunks/${data.chunkId}`)
      const chunk = (tx ? await tx.get(chunkRef) : await chunkRef.get()).data()
      if (!chunk || chunk.digest !== data.digest)
        throw new HttpsError('failed-precondition', 'Missing protected note chunk.')
      notes = chunk.notes
    }
    if (!notes) throw new HttpsError('failed-precondition', 'Missing protected note data.')
    Object.assign(result, notes)
  }
  return result
}
/** All reads must precede this helper; note text never enters public scene documents. */
export function writeNoteSnapshot(tx: Transaction, boardId: string, notes: NoteSnapshot) {
  if (Buffer.byteLength(JSON.stringify(notes)) > 4 * 1024 * 1024)
    throw new HttpsError('resource-exhausted', 'Speaker notes exceed the 4 MiB transaction budget.')
  const db = getFirestore(),
    revisionId = `notes_${randomUUID()}`,
    pages: NoteSnapshot[] = []
  let page: NoteSnapshot = Object.create(null)
  for (const [slideId, note] of Object.entries(notes).sort(([a], [b]) => a.localeCompare(b))) {
    if (Buffer.byteLength(JSON.stringify({ ...page, [slideId]: note })) > PAGE_BYTES) {
      pages.push(page)
      page = Object.create(null)
    }
    page[slideId] = note
  }
  if (Object.keys(page).length) pages.push(page)
  if (pages.length > 100) throw new HttpsError('resource-exhausted', 'Speaker note snapshot exceeds the board budget.')
  const root = `boardScenes/${boardId}/noteRevisions/${revisionId}`
  pages.forEach((notes, slot) => {
    const digest = createHash('sha256').update(JSON.stringify(notes)).digest('hex'),
      chunkId = `note_${digest}`
    // Identical pages share one protected immutable payload, including across restores.
    tx.set(db.doc(`boardScenes/${boardId}/noteChunks/${chunkId}`), { notes, digest })
    tx.create(db.doc(`${root}/pages/${String(slot).padStart(6, '0')}`), { chunkId, digest })
    tx.set(db.doc(`boardScenes/${boardId}/noteChunkReferences/${chunkId}/revisions/${revisionId}`), {
      createdAt: new Date().toISOString(),
    })
  })
  tx.create(db.doc(root), { pageCount: pages.length, createdAt: new Date().toISOString() })
  return revisionId
}
