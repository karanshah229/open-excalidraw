import { pruneCheckpointedRecords } from './scene-compaction-cleanup.js';
import { runWithAbandonedRoomFence } from './scene-collaboration-fence.js';
import { initializeApp } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { getFirestore } from 'firebase-admin/firestore';
import { onValueDeleted } from 'firebase-functions/v2/database';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { HttpsError, onCall, onRequest } from 'firebase-functions/v2/https';
import { defineBoolean, defineString } from 'firebase-functions/params';
import { checkpointScene, ensureScene } from './board-scenes.js';
import { collectQuarantinedOrphanChunks, quarantineSceneOrphanChunks } from './scene-maintenance-gc.js';
import { mintSceneConnectionEpochForSession } from './scene-connection-epoch.js';
export { ensureBoardScene, commitBoardScene, beginBoardSceneUpload, stageBoardSceneChunk, stageBoardScenePage, acquireBoardSceneReadPin, createNamedBoardSceneVersion, prepareBoardSceneGenerationReset, listNamedBoardSceneVersions, acquireNamedBoardSceneVersionReadPin, readBoardScenePage, readBoardSceneChunks, renewBoardSceneReadPin, releaseBoardSceneReadPin, repackBoardScene, } from './board-scenes.js';
import { mirrorCurrentPolicy } from './project-access.js';
export { manageProject, manageBoardAccess, listSharedProjects, createProjectBoard, mirrorProjectAccess, publishProjectBoard, } from './project-access.js';
initializeApp();
export { boardAsset } from './board-assets.js';
export { slideNotes } from './slide-notes.js';
export { mintSceneConnectionEpochForSession } from './scene-connection-epoch.js';
export { fenceBoardSceneGenerationReset, publishBoardSceneGenerationReset, activateBoardSceneGenerationReset, } from './scene-generation-reset.js';
const GRACE_PERIOD_MS = 30_000;
// Longer than the trigger's 120s hard timeout, so a live worker cannot lose its lease.
const COMPACTION_LOCK_MS = 180_000;
// These deploy-time parameters prevent an implicit fallback to a region that
// may be far from, or incompatible with, the triggering data store.
const rtdbFunctionRegion = defineString('RTDB_FUNCTION_REGION');
const firestoreFunctionRegion = defineString('FIRESTORE_FUNCTION_REGION');
const syncAccessFunctionRegion = defineString('SYNC_ACCESS_FUNCTION_REGION');
const tombstoneCompactionEnabled = defineBoolean('SCENE_TOMBSTONE_COMPACTION_ENABLED', { default: false });
function mergeDeltas(baseElements, records) {
    const elements = new Map();
    for (const element of baseElements)
        if (element?.id)
            elements.set(element.id, { ...element });
    for (const record of records) {
        if (!record.id || typeof record.data !== 'string')
            continue;
        let patch;
        try {
            patch = JSON.parse(record.data);
        }
        catch {
            continue;
        }
        if (!patch?.id || patch.id !== record.id)
            continue;
        const existing = elements.get(patch.id);
        if (!existing) {
            if (typeof patch.type !== 'string' ||
                typeof patch.x !== 'number' ||
                typeof patch.y !== 'number' ||
                typeof patch.width !== 'number' ||
                typeof patch.height !== 'number') {
                continue;
            }
            elements.set(patch.id, patch);
            continue;
        }
        const version = Number(patch.version ?? record.version ?? 0);
        const nonce = Number(patch.versionNonce ?? record.versionNonce ?? 0);
        const existingVersion = Number(existing.version ?? 0);
        const existingNonce = Number(existing.versionNonce ?? 0);
        if (version > existingVersion || (version === existingVersion && nonce < existingNonce)) {
            elements.set(patch.id, { ...existing, ...patch });
        }
    }
    return Array.from(elements.values());
}
/**
 * Compacts an abandoned live room after a grace period. This is the durable
 * fallback for simultaneous crashes, where no browser remains to flush state.
 */
export const compactAbandonedCollaborationRoom = onValueDeleted({ ref: '/presence/{boardId}/{sessionId}', region: rtdbFunctionRegion, timeoutSeconds: 120 }, async (event) => {
    const boardId = event.params.boardId;
    const rtdb = getDatabase();
    const firestore = getFirestore();
    const presenceRef = rtdb.ref(`presence/${boardId}`);
    if ((await presenceRef.get()).exists())
        return;
    await new Promise((resolve) => setTimeout(resolve, GRACE_PERIOD_MS));
    if ((await presenceRef.get()).exists())
        return;
    const lockToken = `${event.id}-${Date.now()}`;
    const elementsRef = rtdb.ref(`boards/${boardId}/elements`);
    await runWithAbandonedRoomFence({
        rtdb,
        boardId,
        lockToken,
        lockDurationMs: COMPACTION_LOCK_MS,
        work: async () => {
            const deltaSnapshot = await elementsRef.get();
            const records = Object.values((deltaSnapshot.val() ?? {}));
            const share = (await firestore.doc(`boardShares/${boardId}`).get()).data();
            if (!share || share.deletedAt || share.pending)
                return false;
            const actor = { uid: share.ownerId, trusted: true };
            await ensureScene(boardId, actor, share.projectId);
            let compacted = false;
            for (let attempt = 0; attempt < 4; attempt++) {
                const head = (await firestore.doc(`boardScenes/${boardId}`).get()).data();
                // Generation 1 accepts legacy rooms; future restore generations require explicit room identity.
                const room = (await rtdb.ref(`boards/${boardId}/generation`).get()).val();
                if ((room == null && head.generation !== 1) || (room != null && room !== head.generation))
                    return false;
                try {
                    await checkpointScene(boardId, (scene) => ({ ...scene, elements: mergeDeltas(scene.elements, records) }), head, actor, { compactTombstones: tombstoneCompactionEnabled.value() });
                    compacted = true;
                    break;
                }
                catch (error) {
                    if (error.code !== 'aborted')
                        throw error;
                }
            }
            // Delete only the records actually checkpointed. A replacement under the same ID survives.
            if (compacted && deltaSnapshot.exists()) {
                await pruneCheckpointedRecords(elementsRef, presenceRef, deltaSnapshot.val());
            }
            return compacted;
        },
    });
});
/** Mirrors Firestore sharing policy into RTDB because RTDB rules cannot query Firestore. */
export const mirrorBoardAccessToRtdb = onDocumentWritten({ document: 'boardShares/{boardId}', region: firestoreFunctionRegion }, async (event) => {
    const boardId = event.params.boardId;
    await mirrorCurrentPolicy('board', boardId);
});
/**
 * Synchronously establishes RTDB access after an owner saves sharing policy.
 * The Firestore trigger above stays as an eventual-consistency repair path.
 */
export const syncBoardAccessToRtdb = onCall({ region: syncAccessFunctionRegion }, async (request) => {
    if (!request.auth)
        throw new HttpsError('unauthenticated', 'Authentication is required.');
    const boardId = request.data?.boardId;
    if (typeof boardId !== 'string' || !boardId) {
        throw new HttpsError('invalid-argument', 'A board ID is required.');
    }
    const board = await getFirestore().doc(`boardShares/${boardId}`).get();
    if (!board.exists)
        throw new HttpsError('not-found', 'Board sharing policy was not found.');
    const config = board.data() ?? {};
    if (config.ownerId !== request.auth.uid) {
        throw new HttpsError('permission-denied', 'Only the board owner can synchronize sharing access.');
    }
    await mirrorCurrentPolicy('board', boardId);
    return { mirrored: true };
});
/** Mints a server-owned collaboration epoch before this session may publish presence or deltas. */
export const mintSceneConnectionEpoch = onCall({ region: rtdbFunctionRegion }, async (request) => {
    return mintSceneConnectionEpochForSession(request.auth
        ? {
            uid: request.auth.uid,
            email: typeof request.auth.token.email === 'string' ? request.auth.token.email : undefined,
            emailVerified: request.auth.token.email_verified === true,
        }
        : {}, request.data?.boardId, request.data?.sessionId, request.data?.sceneGeneration);
});
/** Private, dev-only canary runner. IAM invocation and a strict synthetic-board prefix keep it out of user flows. */
export const sceneMaintenanceCanary = onRequest({ region: syncAccessFunctionRegion, invoker: 'private', timeoutSeconds: 120 }, async (request, response) => {
    if (process.env.GCLOUD_PROJECT !== 'open-excalidraw-dev-2') {
        response.sendStatus(404);
        return;
    }
    if (request.method !== 'POST') {
        response.sendStatus(405);
        return;
    }
    const { action, boardId, jobId } = request.body ?? {};
    if (typeof boardId !== 'string' || !/^scene_maintenance_canary_[A-Za-z0-9_-]{8,120}$/.test(boardId) ||
        (action !== 'quarantine' && action !== 'collect') ||
        (action === 'collect' && (typeof jobId !== 'string' || !/^gc_[A-Za-z0-9_-]{8,120}$/.test(jobId)))) {
        response.status(400).json({ error: 'Invalid canary request.' });
        return;
    }
    try {
        const result = action === 'quarantine'
            ? await quarantineSceneOrphanChunks(boardId)
            : await collectQuarantinedOrphanChunks(boardId, jobId, { allowSyntheticCanaryFastTrack: true });
        response.status(200).json(result);
    }
    catch {
        console.error('Scene maintenance canary operation failed.');
        response.status(500).json({ error: 'Canary operation failed; inspect the persisted maintenance job.' });
    }
});
