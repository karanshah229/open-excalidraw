import { initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { mirrorCurrentPolicy } from './project-access.js'

initializeApp()

/** Upgrade mirrors and bind legacy board shares to their verified private parent. */
async function run() {
  const db = getFirestore()
  // Register legacy private boards outside the Share modal. Never replace existing grants.
  for (const project of (await db.collectionGroup('projects').get()).docs) {
    if (!/^users\/[^/]+\/projects\/[^/]+$/.test(project.ref.path) || project.data().deletedAt) continue
    const ownerId = project.ref.path.split('/')[1]
    for (const board of (await project.ref.collection('boards').get()).docs) {
      const data = board.data(),
        ref = db.doc(`boardShares/${board.id}`)
      if (data.active === false) continue
      await db.runTransaction(async (tx) => {
        if ((await tx.get(ref)).exists) return
        tx.create(ref, {
          boardId: board.id,
          projectId: project.id,
          ownerId,
          boardName: data.name,
          ownerName: 'Owner',
          scene: data.scene,
          generalAccess: 'restricted',
          generalRole: 'viewer',
          collaborators: {},
          invitedEmails: [],
          inheritProjectAccess: true,
          accessRevision: 1,
          pending: false,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
        })
      })
    }
  }
  const boards = await db.collection('boardShares').get()
  const projectsByOwner = new Map<string, FirebaseFirestore.QueryDocumentSnapshot[]>()
  for (const board of boards.docs) {
    const config = board.data()
    if (!config.projectId && config.ownerId) {
      let projects = projectsByOwner.get(config.ownerId)
      if (!projects) {
        projects = (await db.collection(`users/${config.ownerId}/projects`).get()).docs
        projectsByOwner.set(config.ownerId, projects)
      }
      for (const project of projects) {
        if ((await project.ref.collection('boards').doc(board.id).get()).exists) {
          await board.ref.update({ projectId: project.id, inheritProjectAccess: config.inheritProjectAccess !== false })
          break
        }
      }
    }
    await mirrorCurrentPolicy('board', board.id)
    console.log(`Backfilled ${board.id}`)
  }
  for (const project of (await db.collection('projectShares').get()).docs)
    await mirrorCurrentPolicy('project', project.id)
}
void run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
