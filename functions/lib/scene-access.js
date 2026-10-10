import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { boardRole } from './access-role.js';
function denied() {
    throw new HttpsError('permission-denied', 'Current board editing access is required.');
}
const live = (value) => value && !value.deletedAt && value.active !== false;
/** All governing documents are read again inside publication's transaction. */
export async function authorizeScene(boardId, binding, actor, tx, editing = true) {
    const db = getFirestore();
    const read = async (path) => {
        const ref = db.doc(path);
        return (tx ? await tx.get(ref) : await ref.get()).data();
    };
    const share = await read(`boardShares/${boardId}`);
    if (share && (share.ownerId !== binding.ownerId || (share.projectId ?? null) !== binding.projectId || !live(share)))
        denied();
    let parentPolicy;
    if (binding.projectId) {
        const parent = await read(`users/${binding.ownerId}/projects/${binding.projectId}`);
        const board = await read(`users/${binding.ownerId}/projects/${binding.projectId}/boards/${boardId}`);
        parentPolicy = await read(`projectShares/${binding.projectId}`);
        if (!parent || !live(parent) || parent.ownerId !== binding.ownerId || !live(board))
            denied();
        if (parentPolicy &&
            (!live(parentPolicy) ||
                parentPolicy.ownerId !== binding.ownerId ||
                (parentPolicy.pending && actor.uid !== binding.ownerId)))
            denied();
    }
    else if (!share)
        denied();
    if (actor.trusted) {
        // Trusted compaction remains bound to a live, published board, never private arbitrary IDs.
        if (!share || share.pending || parentPolicy?.pending)
            denied();
        return;
    }
    const role = share
        ? boardRole(share, actor.uid, actor.email, parentPolicy)
        : actor.uid === binding.ownerId
            ? 'owner'
            : null;
    if (!role || (editing && role !== 'owner' && role !== 'editor'))
        denied();
}
