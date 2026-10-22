import { getFirestore, Timestamp, FieldPath } from 'firebase-admin/firestore';
import { getDatabase } from 'firebase-admin/database';
import { getStorage } from 'firebase-admin/storage';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineString } from 'firebase-functions/params';
import { restoreVersion } from './board-history.js';
const region = defineString('SYNC_ACCESS_FUNCTION_REGION');
/** Expiry is enforced on every read immediately. Physical cleanup is bounded and retryable. */
export async function cleanupHistoryPage(now = Date.now()) {
    const db = getFirestore(), journalRef = db.doc('system/boardHistoryCleanup'), journal = (await journalRef.get()).data();
    let query = db
        .collectionGroup('versions')
        .where('expiresAt', '<=', Timestamp.fromMillis(now))
        .orderBy('expiresAt')
        .orderBy(FieldPath.documentId())
        .limit(100);
    if (journal?.cursorPath)
        query = query.startAfter(Timestamp.fromMillis(journal.cursorExpiry), db.doc(journal.cursorPath));
    const rows = await query.get();
    let deleted = 0;
    for (const row of rows.docs) {
        const headRef = row.ref.parent.parent;
        if (!headRef || headRef.parent.id !== 'boardScenes')
            continue;
        await db.runTransaction(async (tx) => {
            const head = (await tx.get(headRef)).data(), version = (await tx.get(row.ref)).data();
            if (!version || head?.currentVersionId === row.id || head?.restoreOperationId)
                return;
            const contexts = await tx.get(headRef
                .collection('readContexts')
                .where('versionId', '==', row.id)
                .where('expiresAt', '>', Timestamp.fromMillis(now))
                .limit(1));
            if (contexts.docs.some((context) => context.data().expiresAt.toMillis() > now))
                return;
            tx.delete(row.ref);
            deleted++;
        });
    }
    await journalRef.set(rows.size === 100
        ? { cursorPath: rows.docs.at(-1).ref.path, cursorExpiry: rows.docs.at(-1).data().expiresAt.toMillis() }
        : { cursorPath: null });
    return { deleted, scanned: rows.size };
}
export const cleanupExpiredBoardHistory = onSchedule({ schedule: 'every 60 minutes', region, timeoutSeconds: 120, memory: '512MiB' }, async () => {
    await cleanupHistoryPage();
    const metadataDb = getFirestore();
    for (const collection of [
        'readContexts',
        'importReceipts',
        'contentReceipts',
        'noteReceipts',
        'restoreOperations',
        'legacyArchive',
    ]) {
        const expired = await metadataDb
            .collectionGroup(collection)
            .where('expiresAt', '<=', Timestamp.now())
            .limit(100)
            .get();
        for (const row of expired.docs) {
            const headRef = row.ref.parent.parent;
            if (!headRef || headRef.parent.id !== 'boardScenes')
                continue;
            const state = row.data().state;
            if (collection === 'restoreOperations' && !['completed', 'failed'].includes(state))
                continue;
            await row.ref.delete();
        }
    }
    const db = getFirestore(), journalRef = db.doc('system/boardHistoryResourceCleanup'), journal = (await journalRef.get()).data();
    let query = db.collection('boardScenes').orderBy('__name__').limit(10);
    if (journal?.cursor)
        query = query.startAfter(journal.cursor);
    const boards = await query.get();
    for (const board of boards.docs)
        await sweepBoardHistoryResources(board.id);
    await journalRef.set({ cursor: boards.size === 10 ? boards.docs.at(-1).id : null });
});
/** A crashed worker cannot leave all editors locked indefinitely. */
export const recoverBoardRestores = onSchedule({ schedule: 'every 1 minutes', region, timeoutSeconds: 120, memory: '512MiB' }, async () => {
    const db = getFirestore();
    const migrations = await db
        .collection('boardScenes')
        .where('migrationLeaseUntil', '<=', Timestamp.now())
        .limit(10)
        .get();
    const { initializeBoardHistory } = await import('./board-scenes.js');
    for (const board of migrations.docs) {
        const head = board.data();
        if (!head.restoreOperationId?.startsWith('migration_'))
            continue;
        try {
            await initializeBoardHistory(board.id, { uid: head.ownerId, trusted: true });
        }
        catch (error) {
            console.error('board-history-migration-recovery', board.id, error);
        }
    }
    const rows = await db
        .collectionGroup('restoreOperations')
        .where('state', 'in', ['preparing', 'published', 'failed-unlock-pending'])
        .where('leaseUntil', '<=', Timestamp.now())
        .orderBy('leaseUntil')
        .limit(20)
        .get();
    for (const row of rows.docs) {
        const operation = row.data(), headRef = row.ref.parent.parent;
        if (!headRef || headRef.parent.id !== 'boardScenes' || operation.leaseUntil.toMillis() > Date.now())
            continue;
        try {
            await restoreVersion(headRef.id, row.id, operation.targetVersionId, { uid: operation.actorUid, email: operation.actorEmail ?? undefined }, operation.sourceGeneration, operation.fence - 1, { recovering: true });
        }
        catch (error) {
            console.error('board-history-restore-recovery', {
                boardId: headRef.id,
                operationId: row.id,
                code: error.code,
            });
        }
    }
});
/** Server publication shares this board lease. Mark/delete are separated by a 24-hour staging grace. */
export async function sweepBoardHistoryResources(boardId, now = Date.now()) {
    const db = getFirestore(), root = `boardScenes/${boardId}`, headRef = db.doc(root), token = `${now}_${Math.random().toString(36).slice(2)}`, grace = 24 * 60 * 60 * 1000, head = await db.runTransaction(async (tx) => {
        const head = (await tx.get(headRef)).data();
        if (!head ||
            !head.historyProtocolVersion ||
            head.restoreOperationId ||
            head.historyCleanupLeaseUntil?.toMillis?.() > now)
            return null;
        tx.update(headRef, {
            historyCleanupLeaseId: token,
            historyCleanupLeaseUntil: Timestamp.fromMillis(now + 120_000),
        });
        return head;
    });
    if (!head)
        return { revisions: 0, chunks: 0, notes: 0 };
    const journalRef = db.doc(`${root}/cleanupJournals/resources`), journal = (await journalRef.get()).data() ?? {}, stats = { revisions: 0, chunks: 0, notes: 0 };
    async function guard() {
        const latest = (await headRef.get()).data();
        if (latest.historyCleanupLeaseId !== token || latest.historyCleanupLeaseUntil.toMillis() <= Date.now())
            throw new Error('History cleanup lease expired');
    }
    async function deleteResource(ref, journal) {
        return db.runTransaction(async (tx) => {
            const latest = (await tx.get(headRef)).data(), resource = await tx.get(ref);
            if (latest?.historyCleanupLeaseId !== token || latest.historyCleanupLeaseUntil?.toMillis() <= Date.now())
                throw new Error('Cleanup resource deletion fence expired');
            if (!resource.exists)
                return false;
            tx.delete(ref);
            if (journal)
                tx.set(db.doc(`${root}/deletionJournals/${ref.parent.id}_${ref.id}`), journal);
            return true;
        });
    }
    async function page(collection, cursor) {
        let query = db.collection(`${root}/${collection}`).orderBy('__name__').limit(20);
        if (cursor)
            query = query.startAfter(cursor);
        return query.get();
    }
    try {
        async function finishJournal(ref, data) {
            for (const path of data.paths ?? [])
                await db.doc(path).delete();
            await ref.delete();
        }
        const pending = await db.collection(`${root}/deletionJournals`).limit(20).get();
        for (const item of pending.docs) {
            await guard();
            await finishJournal(item.ref, item.data());
        }
        const revisions = await page('revisions', journal.revisionCursor);
        for (const revision of revisions.docs) {
            const data = revision.data();
            if (Date.parse(data.createdAt) > now - grace || revision.id === head.headRevisionId)
                continue;
            const versions = await db
                .collection(`${root}/versions`)
                .where('sceneRevisionId', '==', revision.id)
                .limit(1)
                .get(), contexts = await db
                .collection(`${root}/readContexts`)
                .where('sceneRevisionId', '==', revision.id)
                .where('expiresAt', '>', Timestamp.fromMillis(now))
                .limit(1)
                .get(), candidateId = revision.id.startsWith('import_') ? revision.id.slice(7) : revision.id, candidate = (await db.doc(`${root}/uploads/${candidateId}`).get()).data();
            if (!versions.empty ||
                contexts.docs.some((context) => context.data().expiresAt.toMillis() > now) ||
                candidate?.expiresAt?.toMillis?.() > now)
                continue;
            await guard();
            const manifests = await revision.ref.collection('pages').get();
            const paths = [
                ...manifests.docs.map((page) => page.ref.path),
                ...manifests.docs.flatMap((manifest) => (manifest.data().references ?? []).map((reference) => `${root}/chunkReferences/${reference.chunkId}/revisions/${revision.id}`)),
                ...(data.assetResourceIds ?? []).map((assetId) => `${root}/assetReferences/${assetId}/revisions/${revision.id}`),
            ];
            if (!(await deleteResource(revision.ref, { paths })))
                continue;
            await finishJournal(db.doc(`${root}/deletionJournals/revisions_${revision.id}`), { paths });
            stats.revisions++;
        }
        const chunks = await page('chunks', journal.chunkCursor);
        for (const chunk of chunks.docs) {
            const data = chunk.data(), uploadedAt = chunk.createTime?.toMillis() ?? now;
            if (uploadedAt > now - grace)
                continue;
            const references = await db.collection(`${root}/chunkReferences/${chunk.id}/revisions`).limit(1).get(), candidate = data.uploadId ? (await db.doc(`${root}/uploads/${data.uploadId}`).get()).data() : null;
            if (!references.empty || candidate?.expiresAt?.toMillis?.() > now)
                continue;
            // Older deployments lack reverse refs. Until migration backfills them, conservatively retain chunks.
            if (!head.chunkReferencesReady)
                continue;
            await deleteResource(chunk.ref);
            stats.chunks++;
        }
        const notes = await page('noteRevisions', journal.noteCursor);
        for (const note of notes.docs) {
            if (note.id === head.notesRevisionId || Date.parse(note.data().createdAt) > now - grace)
                continue;
            const versions = await db.collection(`${root}/versions`).where('notesRevisionId', '==', note.id).limit(1).get(), contexts = await db
                .collection(`${root}/readContexts`)
                .where('notesRevisionId', '==', note.id)
                .where('expiresAt', '>', Timestamp.fromMillis(now))
                .limit(1)
                .get();
            if (!versions.empty || contexts.docs.some((context) => context.data().expiresAt.toMillis() > now))
                continue;
            await guard();
            const pages = await note.ref.collection('pages').get();
            const paths = [
                ...pages.docs.map((page) => page.ref.path),
                ...pages.docs
                    .filter((page) => page.data().chunkId)
                    .map((page) => `${root}/noteChunkReferences/${page.data().chunkId}/revisions/${note.id}`),
            ];
            if (!(await deleteResource(note.ref, { paths })))
                continue;
            await finishJournal(db.doc(`${root}/deletionJournals/noteRevisions_${note.id}`), { paths });
            stats.notes++;
        }
        const noteChunks = await page('noteChunks', journal.noteChunkCursor);
        for (const chunk of noteChunks.docs) {
            if ((chunk.createTime?.toMillis() ?? now) > now - grace)
                continue;
            const references = await db.collection(`${root}/noteChunkReferences/${chunk.id}/revisions`).limit(1).get();
            if (!references.empty)
                continue;
            await deleteResource(chunk.ref);
        }
        const assets = await page('assetResources', journal.assetCursor);
        for (const asset of assets.docs) {
            const data = asset.data();
            if (data.createdAt.toMillis() > now - grace || (data.state === 'uploading' && data.leaseUntil?.toMillis() > now))
                continue;
            const references = await db.collection(`${root}/assetReferences/${asset.id}/revisions`).limit(1).get();
            if (!references.empty)
                continue;
            const marked = await db.runTransaction(async (tx) => {
                const latest = (await tx.get(headRef)).data(), resource = (await tx.get(asset.ref)).data(), references = await tx.get(db.collection(`${root}/assetReferences/${asset.id}/revisions`).limit(1));
                if (latest?.historyCleanupLeaseId !== token || latest.historyCleanupLeaseUntil?.toMillis() <= Date.now())
                    throw new Error('Asset cleanup lease expired');
                if (!resource || !references.empty || (resource.state === 'uploading' && resource.leaseUntil?.toMillis() > now))
                    return false;
                tx.update(asset.ref, { state: 'deleting', deletionFence: token });
                return true;
            });
            if (!marked)
                continue;
            let objectGeneration = data.objectGeneration;
            if (typeof objectGeneration !== 'string' || !/^[0-9]+$/.test(objectGeneration)) {
                // Reconcile a worker interrupted between immutable upload and reservation completion.
                // The deleting state prevents a publication or a new upload from adopting these bytes.
                let metadata;
                try {
                    ;
                    [metadata] = await getStorage().bucket().file(data.storagePath).getMetadata();
                }
                catch (error) {
                    if (error.code !== 404)
                        throw error;
                    // A missing object stays quarantined: an old storage request may finish after its worker died.
                    await asset.ref.update({ missingObjectObservedAt: Timestamp.now() });
                    continue;
                }
                objectGeneration = String(metadata.generation);
                if (!/^[0-9]+$/.test(objectGeneration))
                    throw new Error('Storage did not supply an exact object generation');
                await db.runTransaction(async (tx) => {
                    const latest = (await tx.get(headRef)).data(), resource = (await tx.get(asset.ref)).data();
                    if (latest?.historyCleanupLeaseId !== token ||
                        latest.historyCleanupLeaseUntil?.toMillis() <= Date.now() ||
                        resource?.state !== 'deleting' ||
                        resource.deletionFence !== token)
                        throw new Error('Asset reconciliation deletion fence expired');
                    tx.update(asset.ref, { objectGeneration });
                });
            }
            try {
                await getStorage()
                    .bucket()
                    .file(data.storagePath)
                    .delete({ ifGenerationMatch: objectGeneration, ignoreNotFound: true });
            }
            catch (error) {
                // A changed object generation cannot be deleted by an old cleanup worker.
                if (error.code !== 412)
                    throw error;
                continue;
            }
            await deleteResource(asset.ref);
        }
        // Generation numbers never repeat: old closed rooms cannot become current after another restore.
        const rtdb = getDatabase(), room = rtdb.ref(`boards/${boardId}`), [roomGeneration, roomFence, roomOperation] = await Promise.all([
            room.child('generation').get(),
            room.child('restoreFence').get(),
            room.child('restoreOperationId').get(),
        ]);
        let generationCursor = journal.generationCursor ?? 1;
        if (roomGeneration.val() === head.generation &&
            roomFence.val() === (head.restoreFence ?? 0) &&
            !roomOperation.exists()) {
            for (let count = 0; count < 2 && generationCursor < head.generation; count++, generationCursor++) {
                await guard();
                await rtdb.ref(`boards/${boardId}/generations/${generationCursor}`).remove();
                await rtdb.ref(`presence/${boardId}/generations/${generationCursor}`).remove();
            }
            if (generationCursor >= head.generation)
                generationCursor = 1;
        }
        await guard();
        await journalRef.set({
            revisionCursor: revisions.size === 20 ? revisions.docs.at(-1).id : null,
            chunkCursor: chunks.size === 20 ? chunks.docs.at(-1).id : null,
            noteCursor: notes.size === 20 ? notes.docs.at(-1).id : null,
            noteChunkCursor: noteChunks.size === 20 ? noteChunks.docs.at(-1).id : null,
            assetCursor: assets.size === 20 ? assets.docs.at(-1).id : null,
            generationCursor,
            updatedAt: Timestamp.now(),
        });
        return stats;
    }
    finally {
        await db.runTransaction(async (tx) => {
            const latest = (await tx.get(headRef)).data();
            if (latest?.historyCleanupLeaseId === token)
                tx.update(headRef, { historyCleanupLeaseId: null, historyCleanupLeaseUntil: null });
        });
    }
}
