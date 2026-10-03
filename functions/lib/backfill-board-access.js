import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { mirrorCurrentPolicy } from './project-access.js';
initializeApp();
/** Upgrade mirrors and bind legacy board shares to their verified private parent. */
async function run() {
    const db = getFirestore();
    const boards = await db.collection('boardShares').get();
    const projectsByOwner = new Map();
    for (const board of boards.docs) {
        const config = board.data();
        if (!config.projectId && config.ownerId) {
            let projects = projectsByOwner.get(config.ownerId);
            if (!projects) {
                projects = (await db.collection(`users/${config.ownerId}/projects`).get()).docs;
                projectsByOwner.set(config.ownerId, projects);
            }
            for (const project of projects) {
                if ((await project.ref.collection('boards').doc(board.id).get()).exists) {
                    await board.ref.update({ projectId: project.id, inheritProjectAccess: config.inheritProjectAccess !== false });
                    break;
                }
            }
        }
        await mirrorCurrentPolicy('board', board.id);
        console.log(`Backfilled ${board.id}`);
    }
    for (const project of (await db.collection('projectShares').get()).docs)
        await mirrorCurrentPolicy('project', project.id);
}
void run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
