import { assertContentWritable, publishContentVersion } from './board-history-model.js';
import { loadNoteSnapshot, writeNoteSnapshot } from './board-history-notes.js';
import { getFirestore } from 'firebase-admin/firestore';
import { defineBoolean, defineString } from 'firebase-functions/params';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { canAccessAsset, canReadSpeakerNotes, isAssetParentActive } from './asset-policy.js';
const region = defineString('SYNC_ACCESS_FUNCTION_REGION');
const enforceAppCheck = defineBoolean('ASSET_ENFORCE_APP_CHECK', { default: true });
const ID = /^[\w-]{1,160}$/;
export const MAX_NOTE_LENGTH = 20000;
/** Notes are never included in board scene documents or public element replication. */
export const slideNotes = onCall({ region, enforceAppCheck: enforceAppCheck.value() }, async (request) => {
    if (!request.auth)
        throw new HttpsError('unauthenticated', 'Sign in to access speaker notes.');
    const { boardId, slideId, projectId, operation, text, revision, mutationId } = request.data ?? {};
    if (![boardId, slideId].every((value) => typeof value === 'string' && ID.test(value)) ||
        !['read', 'write'].includes(operation) ||
        (projectId !== undefined && (typeof projectId !== 'string' || !ID.test(projectId)))) {
        throw new HttpsError('invalid-argument', 'Invalid note request.');
    }
    if (operation === 'write' &&
        (typeof text !== 'string' ||
            text.length > MAX_NOTE_LENGTH ||
            !Number.isSafeInteger(revision) ||
            revision < 0 ||
            typeof mutationId !== 'string' ||
            !ID.test(mutationId))) {
        throw new HttpsError('invalid-argument', 'Invalid note content or revision.');
    }
    const db = getFirestore(), uid = request.auth.uid;
    const noteRef = db.doc(`slideNotes/${boardId}/notes/${slideId}`);
    return db.runTransaction(async (transaction) => {
        const shared = (await transaction.get(db.doc(`boardShares/${boardId}`))).data();
        const ownerId = shared?.ownerId ?? uid;
        const resolvedProjectId = shared?.projectId ?? shared?.sourceProjectId ?? projectId;
        if (typeof ownerId !== 'string' ||
            !ID.test(ownerId) ||
            typeof resolvedProjectId !== 'string' ||
            !ID.test(resolvedProjectId)) {
            throw new HttpsError('permission-denied', 'Board editor access required.');
        }
        const parentPolicy = (await transaction.get(db.doc(`projectShares/${resolvedProjectId}`))).data();
        const project = (await transaction.get(db.doc(`users/${ownerId}/projects/${resolvedProjectId}`))).data();
        const board = (await transaction.get(db.doc(`users/${ownerId}/projects/${resolvedProjectId}/boards/${boardId}`))).data();
        const allowed = shared
            ? operation === 'read'
                ? canReadSpeakerNotes(shared, request.auth, parentPolicy)
                : canAccessAsset(shared, request.auth, true, parentPolicy)
            : ownerId === uid && (!parentPolicy || canAccessAsset(parentPolicy, request.auth, true));
        if (!allowed || !isAssetParentActive(project) || !isAssetParentActive(board)) {
            throw new HttpsError('permission-denied', 'Board editor access required.');
        }
        const head = (await transaction.get(db.doc(`boardScenes/${boardId}`))).data();
        const receiptRef = operation === 'write' ? db.doc(`boardScenes/${boardId}/noteReceipts/${mutationId}`) : null;
        const receipt = receiptRef ? (await transaction.get(receiptRef)).data() : null;
        const snapshot = head ? await loadNoteSnapshot(boardId, head.notesRevisionId ?? null, transaction) : null;
        const existingRaw = (await transaction.get(noteRef)).data();
        const existing = snapshot ? snapshot[slideId] : existingRaw;
        const current = {
            text: existing?.text ?? '',
            revision: existing?.revision ?? 0,
            updatedAt: existing?.updatedAt ?? null,
        };
        if (operation === 'read')
            return { ...current, conflict: false };
        if (receipt) {
            if (receipt.actorUid !== uid ||
                receipt.slideId !== slideId ||
                receipt.text !== text ||
                receipt.generation !== (request.data.generation ?? request.data.expectedGeneration ?? 1))
                throw new HttpsError('already-exists', 'Note mutation identity was reused.');
            return receipt.result;
        }
        if (operation === 'write' && head) {
            if (!Number.isInteger(request.data.generation ?? request.data.expectedGeneration) ||
                !Number.isInteger(request.data.expectedFence))
                throw new HttpsError('invalid-argument', 'Generation and restore fence are required.');
            assertContentWritable(head, request.data.generation ?? request.data.expectedGeneration, request.data.expectedFence);
        }
        if (existingRaw?.mutationId === mutationId && (!head || existingRaw?.generation === head.generation))
            return { ...current, conflict: false };
        if (revision !== current.revision)
            return { ...current, conflict: true };
        const next = { text, revision: current.revision + 1, updatedAt: new Date().toISOString() };
        if (head)
            publishContentVersion(transaction, boardId, head, { uid }, `note_${mutationId}`, {
                notesRevisionId: writeNoteSnapshot(transaction, boardId, { ...snapshot, [slideId]: next }),
            }, 'speaker-note');
        transaction.set(noteRef, { ...next, mutationId, updatedBy: uid, generation: head?.generation ?? 1 });
        transaction.create(receiptRef, {
            actorUid: uid,
            slideId,
            text,
            generation: head?.generation ?? 1,
            result: { ...next, conflict: false },
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        });
        return { ...next, conflict: false };
    });
});
