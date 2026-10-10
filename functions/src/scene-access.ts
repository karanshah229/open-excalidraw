import { getFirestore, type Transaction } from 'firebase-admin/firestore'
import { HttpsError } from 'firebase-functions/v2/https'
import { boardRole } from './access-role.js'

export type SceneActor = { uid: string; email?: string; trusted?: boolean }
export type SceneBinding = { ownerId: string; projectId: string | null }
function denied(): never {
  throw new HttpsError('permission-denied', 'Current board editing access is required.')
}
const live = (value: any) => value && !value.deletedAt && value.active !== false

/** All governing documents are read again inside publication's transaction. */
export async function authorizeScene(
  boardId: string,
  binding: SceneBinding,
  actor: SceneActor,
  tx?: Transaction,
  editing = true,
) {
  const db = getFirestore()
  const read = async (path: string) => {
    const ref = db.doc(path)
    return (tx ? await tx.get(ref) : await ref.get()).data()
  }
  const share = await read(`boardShares/${boardId}`)
  if (share && (share.ownerId !== binding.ownerId || (share.projectId ?? null) !== binding.projectId || !live(share)))
    denied()
  let parentPolicy
  if (binding.projectId) {
    const parent = await read(`users/${binding.ownerId}/projects/${binding.projectId}`)
    const board = await read(`users/${binding.ownerId}/projects/${binding.projectId}/boards/${boardId}`)
    parentPolicy = await read(`projectShares/${binding.projectId}`)
    if (!parent || !live(parent) || parent.ownerId !== binding.ownerId || !live(board)) denied()
    if (
      parentPolicy &&
      (!live(parentPolicy) ||
        parentPolicy.ownerId !== binding.ownerId ||
        (parentPolicy.pending && actor.uid !== binding.ownerId))
    )
      denied()
  } else if (!share) denied()
  if (actor.trusted) {
    // Trusted compaction remains bound to a live, published board, never private arbitrary IDs.
    if (!share || share.pending || parentPolicy?.pending) denied()
    return
  }
  const role = share
    ? boardRole(share, actor.uid, actor.email, parentPolicy)
    : actor.uid === binding.ownerId
      ? 'owner'
      : null
  if (!role || (editing && role !== 'owner' && role !== 'editor')) denied()
}
