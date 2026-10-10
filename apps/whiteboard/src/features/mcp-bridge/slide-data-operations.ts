import { doc, getDoc } from 'firebase/firestore'
import type { SceneSnapshot } from '../scene/scene-session'
import { getSlides, slideMetadata } from '../slides/slide-model'
import { createSlidePreviewCache } from '../slides/slide-preview-cache'
import { queuedSlideRender, slideRenderKey } from '../slides/slide-renderer'
import { callNote, noteKey, readNoteDraft, replaceNoteDraft, type NoteDraft } from '../slides/notes-store'
import { sharingService, policyRole, strongestRole, type BoardShareConfig } from '../sharing/sharing-service'
import { projectService, type ProjectPolicy } from '../sharing/project-service'
import { getFirebaseAuth, getFirestoreDb, isFirebaseConfigured } from '../../lib/firebase'
import { ensureAuthenticatedUser } from '../collaboration/anonymous-user'

export type SlideDataContext = {
  boardId: string
  projectId: string
  identity: string
  role: 'owner' | 'editor' | 'viewer' | 'presentation' | null
  local: boolean
  scene: SceneSnapshot
  config?: BoardShareConfig
}
export const slideDataOperations = new Set([
  'get_slides',
  'get_slide_notes',
  'set_slide_notes',
  'get_slide_preview',
  'get_share_info',
  'share_board',
  'share_project',
])
export function describeSlides(scene: SceneSnapshot) {
  return getSlides(scene.elements).map((slide, index) => ({
    id: slide.id,
    number: index + 1,
    x: slide.x,
    y: slide.y,
    width: slide.width,
    height: slide.height,
    orderKey: slideMetadata(slide)!.orderKey,
    elementIds: scene.elements
      .filter((element) => !element.isDeleted && element.frameId === slide.id)
      .map((element) => element.id),
  }))
}
function patchPolicy<T extends ProjectPolicy>(current: T, operation: Record<string, any>): T {
  if (
    operation.expectedAccessRevision !== undefined &&
    operation.expectedAccessRevision !== (current.accessRevision ?? 0)
  )
    throw new Error(`access_revision_conflict: currentRevision=${current.accessRevision ?? 0}`)
  if (operation.inviteEmail && operation.removeEmail) throw new Error('Use inviteEmail or removeEmail, not both.')
  const next = { ...current, invitedEmails: [...current.invitedEmails], collaborators: { ...current.collaborators } }
  if (operation.generalAccess !== undefined) next.generalAccess = operation.generalAccess
  if (operation.generalRole !== undefined) next.generalRole = operation.generalRole
  if (operation.inheritProjectAccess !== undefined) next.inheritProjectAccess = operation.inheritProjectAccess
  if (operation.inviteEmail) {
    const email = String(operation.inviteEmail).trim().toLowerCase()
    if (!next.invitedEmails.includes(email)) next.invitedEmails.push(email)
    next.collaborators[email] = {
      email,
      role: operation.inviteRole ?? 'editor',
      addedAt: next.collaborators[email]?.addedAt ?? new Date().toISOString(),
    }
  }
  if (operation.removeEmail) {
    const email = String(operation.removeEmail).trim().toLowerCase()
    next.invitedEmails = next.invitedEmails.filter((entry) => entry !== email)
    delete next.collaborators[email]
  }
  return next
}
async function projectInfo(projectId: string) {
  const db = getFirestoreDb()
  if (!db) throw new Error('Project sharing requires cloud access.')
  const snapshot = await getDoc(doc(db, 'projectShares', projectId))
  const user = getFirebaseAuth()?.currentUser
  let policy: ProjectPolicy & { ownerId: string; name?: string }
  if (snapshot.exists()) policy = snapshot.data() as typeof policy
  else {
    if (!user) throw new Error('Project sharing policy not found.')
    const owned = await getDoc(doc(db, 'users', user.uid, 'projects', projectId))
    if (!owned.exists()) throw new Error('Project sharing policy not found.')
    policy = {
      ownerId: user.uid,
      name: owned.data().name,
      generalAccess: 'restricted',
      generalRole: 'viewer',
      collaborators: {},
      invitedEmails: [],
      accessRevision: 0,
    }
  }
  const effectiveRole = policyRole(policy)
  if (!effectiveRole) throw new Error('Project access denied.')
  return { policy, effectiveRole }
}

/** Shared by editor and audience adapters; these operations never need an Excalidraw API. */
export function createSlideDataHandler() {
  const previews = createSlidePreviewCache()
  const pendingPreviews = new Map<string, Promise<Blob | null>>()
  return {
    clear() {
      previews.clear()
      pendingPreviews.clear()
    },
    async handle(operation: Record<string, any>, context: SlideDataContext) {
      if (!context.role) throw new Error('Board access denied.')
      const { boardId, scene } = context
      const canEdit = context.role === 'owner' || context.role === 'editor'
      if (operation.type === 'get_slides') return { boardId, slides: describeSlides(scene) }
      if (
        operation.type === 'get_share_info' ||
        operation.type === 'share_board' ||
        operation.type === 'share_project'
      ) {
        if (operation.type === 'share_project' || operation.projectId) {
          if (operation.boardId) throw new Error('Choose boardId or projectId, not both.')
          const projectId = String(operation.projectId)
          const { policy, effectiveRole } = await projectInfo(projectId)
          if (operation.type === 'share_project') {
            if (effectiveRole !== 'owner') throw new Error('Only the project owner can change sharing.')
            const next = patchPolicy(policy, operation)
            const result = await projectService.manage(projectId, 'share', {
              policy: next,
              expectedRevision: next.accessRevision ?? 0,
            })
            return { ok: true, projectId, shareUrl: `${location.origin}/?projectId=${projectId}`, ...result.policy }
          }
          return {
            ok: true,
            projectId,
            shareUrl: `${location.origin}/?projectId=${projectId}`,
            ...policy,
            effectiveRole,
          }
        }
        const targetBoardId = operation.boardId || boardId
        const current = await sharingService.getShareConfig(targetBoardId)
        if (operation.type === 'share_board') {
          const updated = await sharingService.saveShareConfig(patchPolicy(current, operation))
          return {
            ok: true,
            boardId: targetBoardId,
            shareUrl: `${location.origin}/boards/${targetBoardId}`,
            generalAccess: updated.generalAccess,
            generalRole: updated.generalRole,
            accessRevision: updated.accessRevision,
            inheritProjectAccess: updated.inheritProjectAccess,
            invitedEmails: updated.invitedEmails,
            collaborators: updated.collaborators,
          }
        }
        const { scene: _scene, ...info } = current
        let projectPolicy = current.projectPolicy
        const db = getFirestoreDb()
        if (current.projectId && db) {
          const parent = await getDoc(doc(db, 'projectShares', current.projectId)).catch(() => null)
          projectPolicy = parent?.exists() ? (parent.data() as ProjectPolicy & { ownerId?: string }) : undefined
        }
        const projectRole = current.inheritProjectAccess !== false ? policyRole(projectPolicy) : null
        return {
          ok: true,
          ...info,
          projectPolicy,
          projectRole,
          effectiveRole:
            strongestRole(policyRole(current), projectRole) ?? (targetBoardId === boardId ? context.role : null),
          shareUrl: `${location.origin}/boards/${targetBoardId}`,
        }
      }
      const slide = getSlides(scene.elements).find((entry) => entry.id === operation.slideId)
      if (!slide) throw new Error('Slide not found.')
      if (operation.type === 'get_slide_preview') {
        const key = `${operation.size}:${slideRenderKey(slide, scene)}`
        const slot = `${slide.id}:${operation.size}`
        let blob = previews.get(slot, key)
        const cached = Boolean(blob)
        if (!blob) {
          if (!pendingPreviews.has(key))
            pendingPreviews.set(
              key,
              queuedSlideRender(slide, scene, operation.size, () => true),
            )
          try {
            blob = (await pendingPreviews.get(key)) ?? undefined
          } finally {
            pendingPreviews.delete(key)
          }
          if (!blob) throw new Error('Slide preview unavailable.')
          previews.put(slot, key, blob)
        }
        if (blob.size > 8 * 1024 * 1024) throw new Error('Slide preview exceeds the image size limit.')
        const image = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result).split(',')[1])
          reader.onerror = () => reject(reader.error)
          reader.readAsDataURL(blob!)
        })
        return { boardId, slideId: slide.id, size: operation.size, cached, image }
      }
      if (!canEdit && context.role !== 'presentation')
        throw new Error('Speaker notes require editor or Present access.')
      if (operation.type === 'set_slide_notes' && !canEdit)
        throw new Error('Speaker notes are view-only with Present access.')
      const auth = getFirebaseAuth()
      if (!context.local && auth) await ensureAuthenticatedUser(auth)
      const identity = auth?.currentUser?.uid ?? context.identity
      const key = noteKey(identity, boardId, slide.id)
      const draft = canEdit ? await readNoteDraft(key) : undefined
      const cloud = !context.local && isFirebaseConfigured
      if (operation.type === 'get_slide_notes') {
        const note = cloud ? await callNote('read', boardId, context.projectId, slide.id) : draft
        return {
          boardId,
          slideId: slide.id,
          text: note?.text ?? '',
          noteRevision: note?.revision ?? 0,
          draftMutationId: draft?.mutationId,
          hasUnsyncedDraft: cloud && Boolean(draft?.dirty),
          readOnly: !canEdit,
        }
      }
      if (cloud && draft?.dirty)
        throw new Error('Unsynced speaker-note draft exists. Sync or resolve it in the board first.')
      if (!cloud && draft && draft.mutationId !== operation.expectedDraftMutationId)
        throw new Error('note_draft_conflict: read the current local notes before replacing them.')
      const next: NoteDraft = {
        key,
        text: operation.text,
        revision: operation.expectedRevision,
        dirty: false,
        mutationId: operation.mutationId ?? crypto.randomUUID(),
      }
      if (cloud) {
        const result = await callNote('write', boardId, context.projectId, slide.id, next)
        if (result.conflict) return { ok: false, error: 'note_revision_conflict', currentRevision: result.revision }
        await replaceNoteDraft(key, draft?.mutationId, { ...next, revision: result.revision })
        window.dispatchEvent(new CustomEvent('slide-notes-updated', { detail: { boardId, slideId: slide.id } }))
        return { boardId, slideId: slide.id, noteRevision: result.revision, text: result.text }
      }
      if ((draft?.revision ?? 0) !== next.revision)
        return { ok: false, error: 'note_revision_conflict', currentRevision: draft?.revision ?? 0 }
      next.revision++
      if (!(await replaceNoteDraft(key, draft?.mutationId, next)))
        throw new Error('note_draft_conflict: local notes changed during this operation.')
      window.dispatchEvent(new CustomEvent('slide-notes-updated', { detail: { boardId, slideId: slide.id } }))
      return { boardId, slideId: slide.id, noteRevision: next.revision, text: next.text }
    },
  }
}
