import { randomUUID, createHash } from 'node:crypto';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getDatabase } from 'firebase-admin/database';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineBoolean, defineString } from 'firebase-functions/params';
import { indexSceneAssets, validateSceneAssetResources } from './board-history-assets.js';
import { canReadSpeakerNotes } from './asset-policy.js';
import { authorizeScene } from './scene-access.js';
import { historyId, ancestorBranchPrefixes, eligibleVersion, versionExpired, assertContentWritable, publishContentVersion, } from './board-history-model.js';
import { assembleScene, manifestDigest, paginateReferences } from './scene-codec.js';
import { loadNoteSnapshot, writeNoteSnapshot } from './board-history-notes.js';
const region = defineString('SYNC_ACCESS_FUNCTION_REGION'), appCheck = defineBoolean('ASSET_ENFORCE_APP_CHECK', { default: true });
const actorOf = (request) => {
    if (!request.auth)
        throw new HttpsError('unauthenticated', 'Sign in to access board history.');
    return { uid: request.auth.uid, email: request.auth.token.email_verified ? request.auth.token.email : undefined };
};
const iso = (value) => value?.toDate?.().toISOString() ?? value;
const publicVersion = (versionId, version, head) => ({
    ...version,
    versionId,
    serverCreatedAt: iso(version.serverCreatedAt),
    expiresAt: iso(version.expiresAt),
    current: head.currentVersionId === versionId,
});
async function getMany(paths) {
    const db = getFirestore(), snapshots = [];
    for (let offset = 0; offset < paths.length; offset += 40)
        snapshots.push(...await db.getAll(...paths.slice(offset, offset + 40).map((path) => db.doc(path))));
    return snapshots;
}
export async function authorizeHistoryContext(boardId, contextId, actor, editing = false) {
    const db = getFirestore(), head = (await db.doc(`boardScenes/${boardId}`).get()).data(), context = (await db.doc(`boardScenes/${boardId}/readContexts/${historyId(contextId)}`).get()).data();
    if (!head || !context || context.actorUid !== actor.uid || context.expiresAt.toMillis() <= Date.now())
        throw new HttpsError('failed-precondition', 'Preview context expired. Open this version again.');
    await authorizeScene(boardId, head, actor, undefined, editing || context.historical);
    if (head.restoreOperationId ||
        head.generation !== context.headGeneration ||
        (head.historyEpoch ?? 0) !== context.historyEpoch)
        throw new HttpsError('aborted', 'The board was restored. Open this version again.');
    if (context.historical && !(await eligibleVersion(boardId, head, context)))
        throw new HttpsError('permission-denied', 'This history branch is inactive.');
    return { head, context };
}
/** Asset gateway uses the same fixed-manifest context, not a caller supplied version ID alone. */
export async function authorizeHistoryAsset(boardId, contextId, actor, storagePath) {
    const { context } = await authorizeHistoryContext(boardId, contextId, actor);
    const { loadSceneRevision } = await import('./board-scenes.js');
    const { scene } = await loadSceneRevision(boardId, {
        headRevisionId: context.sceneRevisionId,
        generation: context.sceneGeneration,
    });
    if (!Object.values(scene.files ?? {}).some((file) => file.storagePath === storagePath))
        throw new HttpsError('permission-denied', 'Image is not part of this board snapshot.');
    return context;
}
/** Merge only admitted branch prefixes: abandoned futures never cost empty pagination pages. */
async function listEligibleVersions(boardId, head, opaqueCursor) {
    const db = getFirestore(), root = `boardScenes/${boardId}`, epoch = head.historyEpoch ?? 0;
    let cursor;
    if (opaqueCursor !== undefined && opaqueCursor !== null) {
        try {
            if (typeof opaqueCursor !== 'string' || opaqueCursor.length > 128 * 1024)
                throw new Error('cursor');
            cursor = JSON.parse(Buffer.from(opaqueCursor, 'base64url').toString());
            if (!cursor || cursor.generation !== head.generation || cursor.epoch !== epoch)
                throw new HttpsError('aborted', 'The board was restored. Reload history.');
            if (!cursor.ceilings || typeof cursor.ceilings !== 'object' || Array.isArray(cursor.ceilings))
                throw new Error('cursor');
        }
        catch (error) {
            if (error instanceof HttpsError)
                throw error;
            throw new HttpsError('invalid-argument', 'Invalid history cursor.');
        }
    }
    const allowed = { ...(head.branchCeilings ?? {}) };
    // Initial baseline from the protocol predating compact prefix metadata.
    if (!Object.keys(allowed).length && head.currentBranchId)
        Object.assign(allowed, await db.runTransaction((tx) => ancestorBranchPrefixes(boardId, head.currentBranchId, head.branchSequence, tx)));
    allowed[head.currentBranchId] = head.branchSequence;
    const imported = await db
        .collection(`${root}/branches`)
        .where('kind', '==', 'local-import')
        .where('generation', '==', head.generation)
        .where('admittedHistoryEpoch', '==', epoch)
        .limit(513)
        .get();
    for (const branch of imported.docs)
        allowed[branch.id] = branch.data().lastSequence ?? Number.MAX_SAFE_INTEGER;
    if (Object.keys(allowed).length > 512)
        throw new HttpsError('resource-exhausted', 'History has too many active branches to page safely.');
    const ceilings = cursor ? { ...cursor.ceilings } : { ...allowed };
    for (const [branchId, value] of Object.entries(ceilings)) {
        historyId(branchId);
        if (!Number.isSafeInteger(value) || value < 0 || !Object.hasOwn(allowed, branchId) || value > allowed[branchId])
            throw new HttpsError('invalid-argument', 'Invalid history branch cursor.');
    }
    const streams = Object.keys(ceilings)
        .filter((id) => ceilings[id] > 0)
        .map((branchId) => ({ branchId, rows: [], exhausted: false }));
    const fill = async (stream) => {
        const result = await db
            .collection(`${root}/versions`)
            .where('branchId', '==', stream.branchId)
            .where('branchSequence', '<=', ceilings[stream.branchId])
            .orderBy('branchSequence', 'desc')
            .limit(50)
            .get();
        stream.rows = result.docs;
        stream.exhausted = result.size < 50;
        if (!result.size)
            ceilings[stream.branchId] = 0;
    };
    // Bound concurrent reads as well as each immutable branch stream.
    for (let index = 0; index < streams.length; index += 16)
        await Promise.all(streams.slice(index, index + 16).map(fill));
    const entries = [];
    let scans = 0;
    while (entries.length < 50 && scans < 5000) {
        let selected;
        for (const stream of streams) {
            if (!stream.rows.length)
                continue;
            const row = stream.rows[0], winner = selected?.rows[0];
            if (!winner ||
                row.data().serverCreatedAt.toMillis() > winner.data().serverCreatedAt.toMillis() ||
                (row.data().serverCreatedAt.toMillis() === winner.data().serverCreatedAt.toMillis() && row.id > winner.id))
                selected = stream;
        }
        if (!selected)
            break;
        const row = selected.rows.shift(), version = row.data();
        ceilings[selected.branchId] = version.branchSequence - 1;
        scans++;
        if (!versionExpired(version) || row.id === head.currentVersionId)
            entries.push(publicVersion(row.id, version, head));
        if (!selected.rows.length && !selected.exhausted && ceilings[selected.branchId] > 0)
            await fill(selected);
    }
    const latest = (await db.doc(root).get()).data();
    if (!latest || latest.generation !== head.generation || (latest.historyEpoch ?? 0) !== epoch)
        throw new HttpsError('aborted', 'The board was restored. Reload history.');
    const hasMore = streams.some((stream) => stream.rows.length > 0 || (!stream.exhausted && ceilings[stream.branchId] > 0));
    return {
        entries,
        cursor: hasMore
            ? Buffer.from(JSON.stringify({ generation: head.generation, epoch, ceilings })).toString('base64url')
            : null,
    };
}
export const boardHistory = onCall({ region, enforceAppCheck: appCheck.value(), memory: '512MiB' }, async (request) => {
    const actor = actorOf(request), boardId = historyId(request.data?.boardId), operation = request.data?.operation, db = getFirestore(), root = `boardScenes/${boardId}`, head = (await db.doc(root).get()).data();
    if (!head)
        throw new HttpsError('not-found', 'Board not found.');
    await authorizeScene(boardId, head, actor, undefined, operation === 'list' || operation === 'restore-status' || operation === 'receipt' || !!request.data?.versionId);
    if (operation === 'receipt') {
        const receipt = (await db.doc(`${root}/importReceipts/${historyId(request.data.captureMutationId)}`).get()).data();
        if (!receipt)
            return { receipt: null };
        if (receipt.actorUid !== actor.uid)
            throw new HttpsError('permission-denied', 'Capture belongs to another actor.');
        return { receipt: receipt.result };
    }
    if (operation === 'restore-status') {
        const status = (await db.doc(`${root}/restoreOperations/${historyId(request.data.operationId)}`).get()).data();
        if (!status)
            return { state: 'unknown' };
        if (status.actorUid !== actor.uid)
            throw new HttpsError('permission-denied', 'Restore belongs to another actor.');
        return { state: status.state, result: status.result ?? null, errorCode: status.errorCode ?? null };
    }
    if (operation === 'list')
        return listEligibleVersions(boardId, head, request.data.cursor);
    if (operation === 'current-scene' && head.historyProtocolVersion !== 1)
        return { legacy: true };
    if (operation === 'manifest' || operation === 'current-scene') {
        const versionId = request.data.versionId ? historyId(request.data.versionId) : head.currentVersionId, historical = !!request.data.versionId && versionId !== head.currentVersionId;
        const version = versionId
            ? (await db.doc(`${root}/versions/${versionId}`).get()).data()
            : {
                sceneRevisionId: head.headRevisionId,
                sceneGeneration: head.generation,
                notesRevisionId: head.notesRevisionId ?? null,
                boardName: head.boardName ?? 'Untitled board',
                branchId: head.currentBranchId,
                branchSequence: head.branchSequence,
            };
        if (!version || (historical && (versionExpired(version) || !(await eligibleVersion(boardId, head, version)))))
            throw new HttpsError('not-found', 'Version is unavailable.');
        const revision = (await db.doc(`${root}/revisions/${version.sceneRevisionId}`).get()).data(), notes = version.notesRevisionId
            ? (await db.doc(`${root}/noteRevisions/${version.notesRevisionId}`).get()).data()
            : null;
        if (!revision)
            throw new HttpsError('failed-precondition', 'Snapshot manifest is missing.');
        const { loadSceneManifest } = await import('./board-scenes.js');
        const { references } = await loadSceneManifest(boardId, {
            headRevisionId: version.sceneRevisionId,
            generation: version.sceneGeneration,
        });
        const contextId = randomUUID(), expiresAt = Timestamp.fromMillis(Date.now() + 5 * 60 * 1000);
        await db.runTransaction(async (tx) => {
            const latest = (await tx.get(db.doc(root))).data();
            await authorizeScene(boardId, latest, actor, tx, historical);
            if (latest.historyCleanupLeaseUntil?.toMillis?.() > Date.now())
                throw new HttpsError('unavailable', 'History cleanup is in progress.');
            if (latest.generation !== head.generation ||
                latest.restoreOperationId ||
                (latest.historyEpoch ?? 0) !== (head.historyEpoch ?? 0))
                throw new HttpsError('aborted', 'The board changed while opening this version.');
            if (historical && !(await eligibleVersion(boardId, latest, version, tx)))
                throw new HttpsError('not-found', 'Version is inactive.');
            tx.create(db.doc(`${root}/readContexts/${contextId}`), {
                ...version,
                versionId: versionId ?? null,
                actorUid: actor.uid,
                historical,
                headGeneration: head.generation,
                historyEpoch: head.historyEpoch ?? 0,
                expiresAt,
            });
        });
        let notesReadable = historical || actor.uid === head.ownerId;
        if (!notesReadable) {
            const [share, parent] = await Promise.all([
                db.doc(`boardShares/${boardId}`).get(),
                head.projectId ? db.doc(`projectShares/${head.projectId}`).get() : Promise.resolve(undefined),
            ]);
            notesReadable = !!share.data() && canReadSpeakerNotes(share.data(), request.auth, parent?.data());
        }
        // Keep the initial paint response small; follow-up batches can be larger.
        const initialReferences = references.slice(0, 3);
        const initialSnapshots = await getMany(initialReferences.map((reference) => `${root}/chunks/${historyId(reference.chunkId)}`));
        const chunks = initialSnapshots.map((snapshot, index) => {
            const chunk = snapshot.data();
            if (!snapshot.exists || !chunk || chunk.digest !== initialReferences[index].digest || chunk.generation !== version.sceneGeneration)
                throw new HttpsError('failed-precondition', 'Missing snapshot chunk.');
            return { chunkId: snapshot.id, digest: chunk.digest, payload: chunk.payload };
        });
        return {
            contextId,
            versionId: versionId ?? null,
            revisionId: version.sceneRevisionId,
            generation: version.sceneGeneration,
            boardName: version.boardName,
            pageCount: revision.pageCount,
            chunkCount: revision.chunkCount,
            candidateDigest: revision.candidateDigest,
            references,
            chunks,
            historyProtocolVersion: head.historyProtocolVersion ?? 1,
            restoreFence: head.restoreFence ?? 0,
            currentVersionId: head.currentVersionId ?? null,
            nameRevision: head.nameRevision ?? 0,
            notesPageCount: notesReadable ? (notes?.pageCount ?? 0) : 0,
            expiresAt: iso(expiresAt),
        };
    }
    const { context } = await authorizeHistoryContext(boardId, historyId(request.data.contextId), actor, false);
    if (operation === 'notes') {
        if (context.historical)
            await authorizeScene(boardId, head, actor);
        else {
            const share = (await db.doc(`boardShares/${boardId}`).get()).data(), parent = head.projectId ? (await db.doc(`projectShares/${head.projectId}`).get()).data() : undefined;
            if (!(actor.uid === head.ownerId || (share && canReadSpeakerNotes(share, request.auth, parent))))
                throw new HttpsError('permission-denied', 'Speaker notes access required.');
        }
    }
    if (operation === 'pages' || operation === 'notes') {
        const page = request.data.page;
        if (!Number.isInteger(page) || page < 0 || page >= (operation === 'pages' ? 6 : 100))
            throw new HttpsError('invalid-argument', 'Invalid manifest page.');
        const path = operation === 'pages' ? `revisions/${context.sceneRevisionId}` : `noteRevisions/${context.notesRevisionId}`, data = (await db.doc(`${root}/${path}/pages/${String(page).padStart(6, '0')}`).get()).data();
        if (!data)
            throw new HttpsError('not-found', 'Manifest page not found.');
        if (operation === 'notes' && data.chunkId) {
            const chunk = (await db.doc(`${root}/noteChunks/${data.chunkId}`).get()).data();
            if (!chunk || chunk.digest !== data.digest)
                throw new HttpsError('failed-precondition', 'Missing protected note page.');
            return { notes: chunk.notes };
        }
        return data;
    }
    if (operation === 'chunks') {
        const chunkIds = request.data.chunkIds;
        if (!Array.isArray(chunkIds) || !chunkIds.length || chunkIds.length > 6)
            throw new HttpsError('invalid-argument', 'Request one to six chunks.');
        const { loadSceneManifest } = await import('./board-scenes.js'), { references } = await loadSceneManifest(boardId, {
            headRevisionId: context.sceneRevisionId,
            generation: context.sceneGeneration,
        }), allowed = new Map(references.map((ref) => [ref.chunkId, ref.digest]));
        const chunks = [];
        for (const candidate of chunkIds) {
            const chunkId = historyId(candidate);
            if (!allowed.has(chunkId))
                throw new HttpsError('permission-denied', 'Chunk is outside this snapshot.');
            const chunk = (await db.doc(`${root}/chunks/${chunkId}`).get()).data();
            if (!chunk || chunk.digest !== allowed.get(chunkId))
                throw new HttpsError('failed-precondition', 'Missing snapshot chunk.');
            chunks.push({ chunkId, digest: chunk.digest, payload: chunk.payload });
        }
        return { chunks };
    }
    throw new HttpsError('invalid-argument', 'Unknown history operation.');
});
export const updateBoardContent = onCall({ region, enforceAppCheck: appCheck.value() }, async (request) => {
    const actor = actorOf(request), boardId = historyId(request.data.boardId), mutationId = historyId(request.data.mutationId), name = request.data.name;
    if (typeof name !== 'string' || !name.trim() || name.length > 500)
        throw new HttpsError('invalid-argument', 'Board name must contain 1 to 500 characters.');
    const db = getFirestore(), root = `boardScenes/${boardId}`;
    return db.runTransaction(async (tx) => {
        const head = (await tx.get(db.doc(root))).data(), receipt = await tx.get(db.doc(`${root}/contentReceipts/${mutationId}`)), share = await tx.get(db.doc(`boardShares/${boardId}`));
        if (!head)
            throw new HttpsError('not-found', 'Board not found.');
        await authorizeScene(boardId, head, actor, tx);
        if (receipt.exists) {
            if (receipt.data().actorUid !== actor.uid || receipt.data().name !== name)
                throw new HttpsError('already-exists', 'Mutation identity was reused.');
            return receipt.data().result;
        }
        assertContentWritable(head, request.data.generation, request.data.expectedFence);
        if (!Number.isInteger(request.data.generation) || !Number.isInteger(request.data.expectedFence))
            throw new HttpsError('invalid-argument', 'Generation and fence are required.');
        if (head.boardName !== name && (head.nameRevision ?? 0) !== request.data.nameRevision)
            throw new HttpsError('aborted', 'Board name changed.', {
                name: head.boardName,
                nameRevision: head.nameRevision ?? 0,
            });
        const result = head.boardName === name
            ? { versionId: head.currentVersionId, nameRevision: head.nameRevision }
            : {
                ...publishContentVersion(tx, boardId, head, actor, `name_${mutationId}`, { boardName: name, nameRevision: (head.nameRevision ?? 0) + 1 }, 'rename'),
                nameRevision: (head.nameRevision ?? 0) + 1,
            };
        if (head.projectId)
            tx.update(db.doc(`users/${head.ownerId}/projects/${head.projectId}/boards/${boardId}`), {
                name,
                updatedAt: new Date().toISOString(),
            });
        if (share.exists)
            tx.update(share.ref, { boardName: name, updatedAt: new Date().toISOString() });
        tx.create(db.doc(`${root}/contentReceipts/${mutationId}`), {
            actorUid: actor.uid,
            name,
            result,
            expiresAt: Timestamp.fromMillis(Date.now() + 30 * 24 * 60 * 60 * 1000),
        });
        return result;
    });
});
export async function restoreVersion(boardId, operationId, versionId, actor, expectedGeneration, expectedFence, options = {}) {
    const db = getFirestore(), root = `boardScenes/${boardId}`, headRef = db.doc(root), operationRef = db.doc(`${root}/restoreOperations/${operationId}`), leaseId = randomUUID();
    const operation = await db.runTransaction(async (tx) => {
        const head = (await tx.get(headRef)).data(), existing = (await tx.get(operationRef)).data(), target = (await tx.get(db.doc(`${root}/versions/${versionId}`))).data();
        if (!head)
            throw new HttpsError('not-found', 'Board not found.');
        if (existing && options.recovering && ['published', 'failed-unlock-pending'].includes(existing.state)) {
            // Mechanical completion of an already-decided operation must survive editor revocation.
        }
        else {
            try {
                await authorizeScene(boardId, head, actor, tx);
            }
            catch (error) {
                if (!options.recovering || !existing || existing.actorUid !== actor.uid || existing.state !== 'preparing')
                    throw error;
                tx.update(operationRef, {
                    state: 'failed-unlock-pending',
                    errorCode: error.code ?? 'permission-denied',
                    leaseId,
                    leaseUntil: Timestamp.fromMillis(Date.now() + 120_000),
                });
                return { ...existing, state: 'failed-unlock-pending', leaseId };
            }
        }
        if (existing) {
            if (existing.actorUid !== actor.uid || existing.targetVersionId !== versionId)
                throw new HttpsError('already-exists', 'Restore identity was reused.');
            if (existing.state === 'completed')
                return existing;
            if (existing.state === 'failed')
                throw new HttpsError('failed-precondition', 'Restore failed. Start a new operation.');
            if (existing.leaseUntil.toMillis() > Date.now())
                throw new HttpsError('unavailable', 'Restore is already in progress.');
            tx.update(operationRef, { leaseId, leaseUntil: Timestamp.fromMillis(Date.now() + 120_000) });
            return { ...existing, leaseId };
        }
        assertContentWritable(head, expectedGeneration, expectedFence);
        if (!target || versionExpired(target) || !(await eligibleVersion(boardId, head, target, tx)))
            throw new HttpsError('not-found', 'Restore target is unavailable.');
        if (head.currentVersionId === versionId)
            throw new HttpsError('failed-precondition', 'This version is already current.');
        const operation = {
            actorUid: actor.uid,
            actorEmail: actor.email ?? null,
            targetVersionId: versionId,
            sourceGeneration: head.generation,
            targetGeneration: head.generation + 1,
            fence: (head.restoreFence ?? 0) + 1,
            state: 'preparing',
            target,
            leaseId,
            leaseUntil: Timestamp.fromMillis(Date.now() + 120_000),
            operationDeadline: Timestamp.fromMillis(Date.now() + 30 * 60 * 1000),
            createdAt: Timestamp.now(),
        };
        tx.create(operationRef, operation);
        tx.update(headRef, { restoreOperationId: operationId, restoreFence: operation.fence });
        return operation;
    });
    if (operation.state === 'completed')
        return operation.result;
    if (operation.state === 'failed-unlock-pending') {
        await finishFailedRestore(boardId, operationId, leaseId);
        throw new HttpsError('failed-precondition', 'Restore failed. Your pending changes were retained.');
    }
    const rtdb = getDatabase(), room = rtdb.ref(`boards/${boardId}`);
    const holdRoom = () => { };
    room.on('value', holdRoom);
    let published = operation.state === 'published';
    const heartbeat = setInterval(() => {
        void db
            .runTransaction(async (tx) => {
            const current = (await tx.get(operationRef)).data();
            if (current?.leaseId === leaseId && ['preparing', 'published'].includes(current.state))
                tx.update(operationRef, {
                    leaseUntil: Timestamp.fromMillis(Math.min(Date.now() + 120_000, current.operationDeadline.toMillis())),
                });
        })
            .catch((error) => console.error('restore-heartbeat', operationId, error));
    }, 30_000);
    try {
        await room.once('value');
        const locked = await room.transaction((current) => {
            if ((current?.restoreFence ?? 0) > operation.fence)
                return;
            if ((current?.restoreFence ?? 0) === operation.fence && current?.restoreOperationId !== operationId) {
                if (published && current?.restoreOperationId == null)
                    return current;
                return;
            }
            return { ...current, restoreOperationId: operationId, restoreFence: operation.fence };
        });
        if (!locked.committed)
            throw new HttpsError('aborted', 'Restore transport fence was superseded.');
        await options.afterLock?.();
        if (!published) {
            const { loadSceneRevision, checkpointScene } = await import('./board-scenes.js');
            let head = (await headRef.get()).data();
            // Drain cloud-accepted deltas while both durable transports are fenced.
            const roomData = (await room.get()).val() ?? {}, deltaValues = {
                ...(operation.sourceGeneration === 1 ? roomData.elements : {}),
                ...roomData.generations?.[operation.sourceGeneration]?.elements,
            };
            if (Object.keys(deltaValues).length) {
                const { scene } = await loadSceneRevision(boardId, head), elements = new Map(scene.elements.map((element) => [element.id, element]));
                for (const record of Object.values(deltaValues)) {
                    let element;
                    try {
                        element = typeof record.data === 'string' ? JSON.parse(record.data) : (record.element ?? record);
                    }
                    catch {
                        continue;
                    }
                    const previous = elements.get(element.id);
                    if (element.id &&
                        (!previous ||
                            element.version > previous.version ||
                            (element.version === previous.version && element.versionNonce < previous.versionNonce)))
                        elements.set(element.id, element);
                }
                await checkpointScene(boardId, { ...scene, elements: [...elements.values()] }, head, { uid: head.ownerId, trusted: true }, operationId);
                head = (await headRef.get()).data();
            }
            const target = operation.target;
            if (target.notesRevisionId)
                await loadNoteSnapshot(boardId, target.notesRevisionId);
            const { chunks, scene: targetScene } = await loadSceneRevision(boardId, {
                headRevisionId: target.sceneRevisionId,
                generation: target.sceneGeneration,
            }), revisionId = `restore_${operationId}`, generation = operation.targetGeneration, references = chunks.map((chunk, slot) => ({
                chunkId: `${revisionId}_${String(slot).padStart(6, '0')}`,
                digest: chunk.digest,
            })), pages = paginateReferences(references), writer = db.bulkWriter();
            chunks.forEach((chunk, slot) => writer.set(db.doc(`${root}/chunks/${references[slot].chunkId}`), {
                payload: chunk.payload,
                digest: chunk.digest,
                generation,
                kind: 'records',
                uploadId: revisionId,
                slot,
                uploaderUid: actor.uid,
            }));
            pages.forEach((references, slot) => writer.set(db.doc(`${root}/revisions/${revisionId}/pages/${String(slot).padStart(6, '0')}`), { references }));
            references.forEach((reference) => writer.set(db.doc(`${root}/chunkReferences/${reference.chunkId}/revisions/${revisionId}`), {
                createdAt: new Date().toISOString(),
            }));
            writer.set(db.doc(`${root}/revisions/${revisionId}`), {
                generation,
                sceneFormatVersion: 1,
                pageCount: pages.length,
                chunkCount: chunks.length,
                candidateDigest: await manifestDigest(references, generation),
                parentRevisionId: head.headRevisionId,
                createdAt: new Date().toISOString(),
                reason: 'restore',
            });
            await writer.close();
            const assetResources = await indexSceneAssets(boardId, revisionId, targetScene);
            await db
                .doc(`${root}/revisions/${revisionId}`)
                .update({ assetResourceIds: assetResources.map((resource) => resource.id) });
            await options.beforePublication?.();
            const result = await db.runTransaction(async (tx) => {
                const latest = (await tx.get(headRef)).data(), currentOperation = (await tx.get(operationRef)).data(), share = await tx.get(db.doc(`boardShares/${boardId}`));
                await authorizeScene(boardId, latest, actor, tx);
                if (currentOperation.state === 'published')
                    return currentOperation.result;
                if (latest.restoreOperationId !== operationId ||
                    latest.restoreFence !== operation.fence ||
                    currentOperation.leaseId !== leaseId ||
                    currentOperation.leaseUntil.toMillis() <= Date.now() ||
                    currentOperation.operationDeadline.toMillis() <= Date.now())
                    throw new HttpsError('aborted', 'Restore worker lost its fence or lease.');
                const targetNow = (await tx.get(db.doc(`${root}/versions/${operation.targetVersionId}`))).data();
                if (!targetNow || !(await eligibleVersion(boardId, latest, targetNow, tx)))
                    throw new HttpsError('aborted', 'Restore target became inactive.');
                const resources = await tx.getAll(...references.map((reference) => db.doc(`${root}/chunks/${reference.chunkId}`)), { fieldMask: ['digest', 'generation', 'deletionFence'] });
                resources.forEach((resource, slot) => {
                    const chunk = resource.data();
                    if (!chunk ||
                        chunk.deletionFence ||
                        chunk.digest !== references[slot].digest ||
                        chunk.generation !== generation)
                        throw new HttpsError('aborted', 'Restore staging resources were collected.');
                });
                await validateSceneAssetResources(tx, boardId, assetResources);
                const ancestors = await ancestorBranchPrefixes(boardId, target.branchId, target.branchSequence, tx);
                const branchId = `restore_${operationId}`, versionId = revisionId;
                const history = publishContentVersion(tx, boardId, latest, actor, versionId, {
                    headRevisionId: revisionId,
                    generation,
                    boardName: target.boardName,
                    nameRevision: (latest.nameRevision ?? 0) + 1,
                    notesRevisionId: target.notesRevisionId ?? writeNoteSnapshot(tx, boardId, {}),
                    currentBranchId: branchId,
                    branchSequence: 1,
                    parentVersionId: operation.targetVersionId,
                    branchCeilings: { ...ancestors, [branchId]: Number.MAX_SAFE_INTEGER },
                    historyEpoch: (latest.historyEpoch ?? 0) + 1,
                    restoreOf: operation.targetVersionId,
                }, 'restore');
                tx.create(db.doc(`${root}/branches/${branchId}`), {
                    kind: 'canonical',
                    generation,
                    parentBranchId: target.branchId,
                    forkSequence: target.branchSequence,
                    forkVersionId: operation.targetVersionId,
                    ancestorCeilings: ancestors,
                    createdAt: Timestamp.now(),
                });
                if (latest.projectId)
                    tx.update(db.doc(`users/${latest.ownerId}/projects/${latest.projectId}/boards/${boardId}`), {
                        name: target.boardName,
                        updatedAt: new Date().toISOString(),
                    });
                if (share.exists)
                    tx.update(share.ref, { boardName: target.boardName, updatedAt: new Date().toISOString() });
                const result = {
                    operationId,
                    state: 'completed',
                    generation,
                    restoreFence: operation.fence,
                    versionId: history.versionId,
                    revisionId,
                };
                tx.update(operationRef, { state: 'published', result });
                return result;
            });
            published = true;
            operation.result = result;
            await options.afterPublication?.();
        }
        const unlock = await room.transaction((current) => {
            if (current?.restoreFence === operation.fence &&
                current.restoreOperationId == null &&
                current.generation === operation.targetGeneration)
                return current;
            if (current?.restoreOperationId !== operationId || current.restoreFence !== operation.fence)
                return;
            const generations = { ...current.generations };
            delete generations[operation.sourceGeneration];
            const next = { ...current, generations, generation: operation.targetGeneration, restoreOperationId: null };
            if (operation.sourceGeneration === 1)
                delete next.elements;
            return next;
        });
        if (!unlock.committed)
            throw new HttpsError('aborted', 'Restore transport fence was superseded.');
        await getDatabase().ref(`presence/${boardId}/generations/${operation.sourceGeneration}`).remove();
        await options.afterTransportUnlock?.();
        await db.runTransaction(async (tx) => {
            const head = (await tx.get(headRef)).data();
            await tx.get(operationRef);
            if (head.restoreOperationId !== operationId || head.restoreFence !== operation.fence)
                throw new HttpsError('aborted', 'Restore fence was superseded.');
            tx.update(headRef, { restoreOperationId: null });
            tx.update(operationRef, {
                state: 'completed',
                completedAt: Timestamp.now(),
                expiresAt: Timestamp.fromMillis(Date.now() + 30 * 24 * 60 * 60 * 1000),
                leaseUntil: Timestamp.now(),
            });
        });
        return operation.result;
    }
    catch (error) {
        if (!published) {
            // Persist failure before transport unlock, so a crash remains recoverable.
            const owned = await db.runTransaction(async (tx) => {
                const head = (await tx.get(headRef)).data(), current = (await tx.get(operationRef)).data();
                if (current?.leaseId !== leaseId || head?.restoreOperationId !== operationId || current?.state !== 'preparing')
                    return false;
                tx.update(operationRef, {
                    state: 'failed-unlock-pending',
                    errorCode: error.code ?? 'internal',
                    leaseUntil: Timestamp.now(),
                });
                return true;
            });
            if (owned) {
                await options.beforeFailedUnlock?.();
                await finishFailedRestore(boardId, operationId, leaseId);
            }
        }
        throw error;
    }
    finally {
        clearInterval(heartbeat);
        room.off('value', holdRoom);
    }
}
async function finishFailedRestore(boardId, operationId, leaseId) {
    const db = getFirestore(), root = `boardScenes/${boardId}`, operationRef = db.doc(`${root}/restoreOperations/${operationId}`), operation = (await operationRef.get()).data();
    if (!operation || operation.state !== 'failed-unlock-pending' || operation.leaseId !== leaseId)
        return;
    const transport = getDatabase().ref(`boards/${boardId}`), hold = () => { };
    transport.on('value', hold);
    await transport.once('value');
    try {
        const unlocked = await transport.transaction((room) => {
            if (room?.restoreOperationId === operationId && room.restoreFence === operation.fence)
                return { ...room, restoreOperationId: null };
            // Failure before transport acquisition, or retry after a completed unlock.
            if (!room?.restoreOperationId && (room?.restoreFence ?? 0) <= operation.fence)
                return room ?? {};
            return;
        });
        if (!unlocked.committed)
            throw new HttpsError('aborted', 'Restore transport ownership changed; recovery will retry.');
    }
    finally {
        transport.off('value', hold);
    }
    await db.runTransaction(async (tx) => {
        const headRef = db.doc(root), head = (await tx.get(headRef)).data(), current = (await tx.get(operationRef)).data();
        if (current?.state !== 'failed-unlock-pending' ||
            current.leaseId !== leaseId ||
            head?.restoreOperationId !== operationId)
            return;
        tx.update(headRef, { restoreOperationId: null });
        tx.update(operationRef, {
            state: 'failed',
            expiresAt: Timestamp.fromMillis(Date.now() + 30 * 24 * 60 * 60 * 1000),
            leaseUntil: Timestamp.now(),
        });
    });
}
export const restoreBoardVersion = onCall({ region, enforceAppCheck: appCheck.value(), timeoutSeconds: 120, memory: '512MiB', concurrency: 4 }, async (request) => {
    if (!Number.isInteger(request.data.expectedGeneration) || !Number.isInteger(request.data.expectedFence))
        throw new HttpsError('invalid-argument', 'Restore generation and fence are required.');
    return restoreVersion(historyId(request.data.boardId), historyId(request.data.operationId), historyId(request.data.versionId), actorOf(request), request.data.expectedGeneration, request.data.expectedFence);
});
/** Accepts a complete local snapshot as history only. Intermediate offline saves never move the head. */
export const importBoardVersion = onCall({ region, enforceAppCheck: appCheck.value(), timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
    const actor = actorOf(request), boardId = historyId(request.data.boardId), commitId = historyId(request.data.commitId), captureMutationId = historyId(request.data.captureMutationId ?? request.data.commitId), sourceBaseVersionId = historyId(request.data.sourceBaseVersionId), localBranchId = historyId(request.data.localBranchId), parentVersionId = request.data.parentVersionId ? historyId(request.data.parentVersionId) : sourceBaseVersionId, boardName = request.data.boardName, capturedAt = request.data.capturedAt, branchSequence = request.data.branchSequence, db = getFirestore(), root = `boardScenes/${boardId}`, branchId = `import_${createHash('sha256').update(`${actor.uid}:${localBranchId}`).digest('hex').slice(0, 40)}`, versionId = `local_${captureMutationId}`, receiptRef = db.doc(`${root}/importReceipts/${captureMutationId}`);
    if (typeof boardName !== 'string' ||
        !boardName.trim() ||
        boardName.length > 500 ||
        typeof capturedAt !== 'string' ||
        !Number.isFinite(Date.parse(capturedAt)) ||
        !Number.isInteger(branchSequence) ||
        branchSequence < 1)
        throw new HttpsError('invalid-argument', 'Invalid local history metadata.');
    const head = (await db.doc(root).get()).data(), candidate = (await db.doc(`${root}/uploads/${commitId}`).get()).data(), source = (await db
        .doc(`${root}/versions/${request.data.canonicalVersionId ? historyId(request.data.canonicalVersionId) : sourceBaseVersionId}`)
        .get()).data(), receipt = (await receiptRef.get()).data();
    if (!head)
        throw new HttpsError('not-found', 'Board not found.');
    await authorizeScene(boardId, head, actor);
    if (receipt &&
        (receipt.actorUid !== actor.uid ||
            receipt.boardName !== boardName ||
            receipt.parentVersionId !== parentVersionId ||
            receipt.sourceBaseVersionId !== sourceBaseVersionId ||
            receipt.branchSequence !== branchSequence ||
            receipt.branchId !== branchId ||
            receipt.capturedAt !== capturedAt))
        throw new HttpsError('already-exists', 'Import identity was reused.');
    if (!candidate || candidate.uploaderUid !== actor.uid)
        throw new HttpsError('permission-denied', 'Candidate belongs to another actor.');
    assertContentWritable(head, candidate.generation, candidate.expectedFence ?? 0);
    if (!source ||
        ((!request.data.canonicalVersionId || request.data.canonicalVersionId !== head.currentVersionId) &&
            versionExpired(source)) ||
        !(await eligibleVersion(boardId, head, source)))
        throw new HttpsError('not-found', 'Import base is no longer eligible.');
    if (source.sceneGeneration !== candidate.generation ||
        !Number.isInteger(candidate.pageCount) ||
        candidate.pageCount < 1 ||
        candidate.pageCount > 6 ||
        !Number.isInteger(candidate.chunkCount) ||
        candidate.chunkCount < 1 ||
        candidate.chunkCount > 512)
        throw new HttpsError('failed-precondition', 'Import requires a current-generation bounded candidate.');
    const { loadSceneManifest, validateAssets } = await import('./board-scenes.js'), base = await loadSceneManifest(boardId, {
        headRevisionId: source.sceneRevisionId,
        generation: source.sceneGeneration,
    }), allowed = new Map(base.references.map((reference) => [reference.chunkId, reference.digest])), references = [];
    if (!request.data.canonicalVersionId && parentVersionId !== sourceBaseVersionId) {
        const parent = (await db.doc(`${root}/versions/${parentVersionId}`).get()).data();
        if (!parent ||
            parent.branchId !== branchId ||
            parent.sceneGeneration !== candidate.generation ||
            !(await eligibleVersion(boardId, head, parent)))
            throw new HttpsError('failed-precondition', 'Import parent is unavailable.');
        const manifest = await loadSceneManifest(boardId, {
            headRevisionId: parent.sceneRevisionId,
            generation: parent.sceneGeneration,
        });
        manifest.references.forEach((reference) => allowed.set(reference.chunkId, reference.digest));
    }
    for (let page = 0; page < candidate.pageCount; page++) {
        const data = (await db.doc(`${root}/uploads/${commitId}/pages/${String(page).padStart(6, '0')}`).get()).data();
        if (!Array.isArray(data?.references) || !data.references.length || data.references.length > 100)
            throw new HttpsError('failed-precondition', 'Incomplete import manifest.');
        references.push(...data.references);
    }
    if (references.length !== candidate.chunkCount ||
        new Set(references.map((reference) => reference.chunkId)).size !== references.length ||
        (await manifestDigest(references, candidate.generation)) !== candidate.candidateDigest)
        throw new HttpsError('failed-precondition', 'Invalid import manifest.');
    const chunks = [], pages = paginateReferences(references);
    let bytes = 0, fresh = 0;
    for (const reference of references) {
        const chunkId = historyId(reference.chunkId), chunk = (await db.doc(`${root}/chunks/${chunkId}`).get()).data();
        if (!chunk ||
            chunk.generation !== candidate.generation ||
            chunk.digest !== reference.digest ||
            typeof chunk.payload !== 'string')
            throw new HttpsError('failed-precondition', 'Invalid import chunk.');
        if (allowed.get(chunkId) !== reference.digest &&
            (chunk.uploadId !== commitId || chunk.uploaderUid !== actor.uid || chunk.slot !== fresh++))
            throw new HttpsError('permission-denied', 'Chunk is outside the authorized import source.');
        bytes += Buffer.byteLength(chunk.payload);
        if (Buffer.byteLength(chunk.payload) > 512 * 1024 || bytes > 64 * 1024 * 1024)
            throw new HttpsError('resource-exhausted', 'Import exceeds scene bounds.');
        chunks.push({ chunkId, digest: chunk.digest, payload: chunk.payload });
    }
    if (fresh !== candidate.newChunkCount)
        throw new HttpsError('failed-precondition', 'Import chunk count mismatch.');
    const importedScene = await assembleScene(chunks);
    validateAssets(boardId, head.ownerId, importedScene);
    const notes = request.data.notes ?? {};
    if (typeof notes !== 'object' ||
        Array.isArray(notes) ||
        notes === null ||
        Buffer.byteLength(JSON.stringify(notes)) > 1024 * 1024)
        throw new HttpsError('invalid-argument', 'Invalid protected note snapshot.');
    for (const [slideId, note] of Object.entries(notes)) {
        historyId(slideId);
        if (typeof note?.text !== 'string' ||
            note.text.length > 20_000 ||
            !Number.isInteger(note.revision) ||
            note.revision < 0)
            throw new HttpsError('invalid-argument', 'Invalid protected note.');
    }
    const canonicalVersionId = request.data.canonicalVersionId ? historyId(request.data.canonicalVersionId) : null;
    let canonicalMatch = false;
    if (canonicalVersionId) {
        const canonicalVersion = (await db.doc(`${root}/versions/${canonicalVersionId}`).get()).data() ?? null;
        if (!canonicalVersion ||
            (versionExpired(canonicalVersion) && canonicalVersionId !== head.currentVersionId) ||
            canonicalVersion.sceneGeneration !== candidate.generation ||
            !(await eligibleVersion(boardId, head, canonicalVersion)))
            throw new HttpsError('failed-precondition', 'Canonical capture target is unavailable.');
        const { loadSceneRevision } = await import('./board-scenes.js');
        const canonicalScene = (await loadSceneRevision(boardId, {
            headRevisionId: canonicalVersion.sceneRevisionId,
            generation: canonicalVersion.sceneGeneration,
        })).scene;
        const canonicalNotes = canonicalVersion.notesRevisionId
            ? await loadNoteSnapshot(boardId, canonicalVersion.notesRevisionId)
            : {};
        const noteTexts = (value) => Object.fromEntries(Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([id, note]) => [id, note.text]));
        const stable = (value) => Array.isArray(value)
            ? value.map(stable)
            : value && typeof value === 'object'
                ? Object.fromEntries(Object.entries(value)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([key, child]) => [key, stable(child)]))
                : value;
        canonicalMatch =
            canonicalVersion.boardName === boardName &&
                JSON.stringify(stable(canonicalScene)) === JSON.stringify(stable(importedScene)) &&
                JSON.stringify(noteTexts(canonicalNotes)) === JSON.stringify(noteTexts(notes));
        if (!canonicalMatch)
            throw new HttpsError('failed-precondition', 'Local capture differs from the requested canonical version.');
    }
    const contentFingerprint = createHash('sha256')
        .update(JSON.stringify({
        importedScene,
        boardName,
        notes,
        branchSequence,
        parentVersionId,
        capturedAt,
        sourceBaseVersionId,
        branchId,
    }))
        .digest('hex');
    if (receipt) {
        if (receipt.contentFingerprint !== contentFingerprint)
            throw new HttpsError('already-exists', 'Import identity content changed.');
        return receipt.result;
    }
    const revisionId = `import_${commitId}`, writer = db.bulkWriter();
    pages.forEach((references, slot) => writer.set(db.doc(`${root}/revisions/${revisionId}/pages/${String(slot).padStart(6, '0')}`), { references }));
    references.forEach((reference) => writer.set(db.doc(`${root}/chunkReferences/${reference.chunkId}/revisions/${revisionId}`), {
        createdAt: new Date().toISOString(),
    }));
    writer.set(db.doc(`${root}/revisions/${revisionId}`), {
        generation: candidate.generation,
        sceneFormatVersion: 1,
        pageCount: pages.length,
        chunkCount: chunks.length,
        candidateDigest: candidate.candidateDigest,
        parentRevisionId: source.sceneRevisionId,
        createdAt: new Date().toISOString(),
        reason: 'offline-import',
    });
    await writer.close();
    const assetResources = await indexSceneAssets(boardId, revisionId, importedScene);
    await db
        .doc(`${root}/revisions/${revisionId}`)
        .update({ assetResourceIds: assetResources.map((resource) => resource.id) });
    return db.runTransaction(async (tx) => {
        const latest = (await tx.get(db.doc(root))).data(), existing = (await tx.get(receiptRef)).data(), sourceNow = (await tx.get(db.doc(`${root}/versions/${sourceBaseVersionId}`))).data(), parent = (await tx.get(db.doc(`${root}/versions/${parentVersionId}`))).data(), branch = (await tx.get(db.doc(`${root}/branches/${branchId}`))).data(), canonicalNow = canonicalVersionId
            ? (await tx.get(db.doc(`${root}/versions/${canonicalVersionId}`))).data()
            : null;
        await authorizeScene(boardId, latest, actor, tx);
        if (existing) {
            if (existing.contentFingerprint !== contentFingerprint)
                throw new HttpsError('already-exists', 'Import identity content changed.');
            return existing.result;
        }
        assertContentWritable(latest, candidate.generation, candidate.expectedFence ?? 0);
        if (canonicalMatch) {
            if (!canonicalNow || !(await eligibleVersion(boardId, latest, canonicalNow, tx)))
                throw new HttpsError('aborted', 'Canonical capture target became inactive.');
            const result = {
                localSnapshotVersionId: canonicalVersionId,
                canonicalVersionId,
                generation: latest.generation,
                acceptedAt: iso(canonicalNow.serverCreatedAt),
                expiresAt: iso(canonicalNow.expiresAt),
            };
            tx.create(receiptRef, {
                actorUid: actor.uid,
                candidateDigest: candidate.candidateDigest,
                contentFingerprint,
                boardName,
                parentVersionId,
                sourceBaseVersionId,
                branchSequence,
                branchId,
                capturedAt,
                expiresAt: Timestamp.fromMillis(Date.parse(result.expiresAt)),
                result,
            });
            return result;
        }
        if (!sourceNow || versionExpired(sourceNow) || !(await eligibleVersion(boardId, latest, sourceNow, tx)))
            throw new HttpsError('aborted', 'Import base is unavailable.');
        if ((branchSequence === 1 && parentVersionId !== sourceBaseVersionId) ||
            (branchSequence > 1 &&
                (!parent || parent.branchId !== branchId || parent.branchSequence !== branchSequence - 1)))
            throw new HttpsError('failed-precondition', 'Import local ancestry is incomplete.');
        if (branch && branch.lastSequence !== undefined && branch.lastSequence !== branchSequence - 1)
            throw new HttpsError('aborted', 'Import branch advanced. Retry its next capture in order.');
        if (branch &&
            (branch.admittedHistoryEpoch !== (latest.historyEpoch ?? 0) || branch.generation !== latest.generation))
            throw new HttpsError('aborted', 'Import branch was abandoned by restore.');
        const resources = await tx.getAll(...references.map((reference) => db.doc(`${root}/chunks/${reference.chunkId}`)), { fieldMask: ['digest', 'generation', 'deletionFence'] });
        resources.forEach((resource, slot) => {
            const chunk = resource.data();
            if (!chunk ||
                chunk.deletionFence ||
                chunk.digest !== references[slot].digest ||
                chunk.generation !== latest.generation)
                throw new HttpsError('aborted', 'Import chunk was collected. Restage this snapshot.');
        });
        await validateSceneAssetResources(tx, boardId, assetResources);
        const ancestors = !branch
            ? await ancestorBranchPrefixes(boardId, sourceNow.branchId, sourceNow.branchSequence, tx)
            : null;
        const now = Timestamp.fromMillis(Math.max(Date.now(), (latest.historyAcceptedAt?.toMillis?.() ?? 0) + 1)), notesRevisionId = writeNoteSnapshot(tx, boardId, notes);
        if (!branch)
            tx.create(db.doc(`${root}/branches/${branchId}`), {
                kind: 'local-import',
                generation: latest.generation,
                admittedHistoryEpoch: latest.historyEpoch ?? 0,
                parentBranchId: sourceNow.branchId,
                forkSequence: sourceNow.branchSequence,
                forkVersionId: sourceBaseVersionId,
                ancestorCeilings: ancestors,
                createdAt: now,
                lastSequence: branchSequence,
            });
        else
            tx.update(db.doc(`${root}/branches/${branchId}`), { lastSequence: branchSequence });
        tx.update(db.doc(root), { historyAcceptedAt: now });
        tx.create(db.doc(`${root}/versions/${versionId}`), {
            sceneRevisionId: revisionId,
            sceneGeneration: candidate.generation,
            boardName,
            notesRevisionId,
            branchId,
            branchSequence,
            parentVersionId,
            sourceBaseVersionId,
            capturedAt,
            actorUid: actor.uid,
            mutationId: commitId,
            origin: 'offline-import',
            reason: 'local-save',
            serverCreatedAt: now,
            expiresAt: Timestamp.fromMillis(now.toMillis() + 30 * 24 * 60 * 60 * 1000),
        });
        const result = {
            localSnapshotVersionId: versionId,
            canonicalVersionId: null,
            generation: latest.generation,
            acceptedAt: now.toDate().toISOString(),
            expiresAt: new Date(now.toMillis() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        };
        tx.create(receiptRef, {
            actorUid: actor.uid,
            candidateDigest: candidate.candidateDigest,
            contentFingerprint,
            boardName,
            parentVersionId,
            sourceBaseVersionId,
            branchSequence,
            branchId,
            capturedAt,
            expiresAt: Timestamp.fromMillis(Date.parse(result.expiresAt)),
            result,
        });
        return result;
    });
});
