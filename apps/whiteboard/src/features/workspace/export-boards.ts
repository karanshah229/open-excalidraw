import type { BoardScene } from '@agentic-whiteboard/storage'
import { collection, doc, getDocs, getDocFromServer as getDoc, query, where } from 'firebase/firestore'
import { get, ref } from 'firebase/database'
import { getFirebaseAuth, getFirebaseRtdb, getFirestoreDb } from '../../lib/firebase'
import { workspaceApi, workspaceStore, workspaceValue, type WorkspaceBoard } from './workspace-api'
import { projectCall, projectService, type VisibleProject } from '../sharing/project-service'
import { sharingService } from '../sharing/sharing-service'
import { restoreSceneAssets } from '../assets/scene-assets'
import { mergeDeltaRecordsOntoBase, reconcileElementsLWW } from '../collaboration/reconcile'

export const exportFormats = ['excalidraw', 'svg', 'png'] as const
export type ExportFormat = (typeof exportFormats)[number]
export type ExportFailure = {
  boardId: string
  boardName: string
  format: ExportFormat
  message: string
  variant?: 'local' | 'cloud'
}
export type ExportResult = {
  files: Record<string, Uint8Array>
  fileNames: string[]
  archiveCount: number
  failures: ExportFailure[]
  captures: { boardId: string; name: string; capturedAt: string; localEdits: boolean; variants: string[] }[]
}
// Strip control bytes and path separators from user-provided archive names.
const safeName = (value: string) =>
  value
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f<>:"/\\|?*]/g, '_')
    .replace(/^\.+|[. ]+$/g, '')
    .slice(0, 100) || 'Untitled'

type ExportBoard = WorkspaceBoard & { cloudStored?: boolean }

async function enumerate(projectId?: string, includeShared = false): Promise<ExportBoard[]> {
  const uid = getFirebaseAuth()?.currentUser?.uid
  const db = getFirestoreDb()
  const online = Boolean(db && uid && navigator.onLine)
  const localInventory = async () => {
    await workspaceStore.bootstrap()
    const projects = await workspaceStore.listProjects()
    const boards = (
      await Promise.all(
        projects.map(async (project) =>
          (await workspaceStore.listBoards(project.id)).map((board) => ({ ...board, project })),
        ),
      )
    ).flat()
    return { projects, boards }
  }
  const [workspace, remoteProjects, shared] = await Promise.all([
    projectId ? workspaceApi.listWorkspace(projectId) : localInventory(),
    online ? getDocs(collection(db!, 'users', uid!, 'projects')) : Promise.resolve(null),
    online && includeShared && !projectId ? projectService.list(undefined, false, true) : Promise.resolve(null),
  ])
  const projects = new Map<string, VisibleProject>(
    workspace.projects
      .filter((project) =>
        projectId ? project.id === projectId : project.ownerId === (uid ?? 'local-user') || includeShared,
      )
      .map((project) => [project.id, project]),
  )
  const deleted = new Set<string>()
  for (const snapshot of remoteProjects?.docs ?? []) {
    if (snapshot.data().deletedAt) {
      deleted.add(snapshot.id)
      projects.delete(snapshot.id)
      continue
    }
    if (!projectId || snapshot.id === projectId)
      projects.set(snapshot.id, {
        ...(workspaceValue(snapshot.data()) as VisibleProject),
        id: snapshot.id,
        ownerId: uid!,
      })
  }
  for (const project of shared?.projects ?? []) projects.set(project.id, project)
  const boards = new Map<string, ExportBoard>(
    workspace.boards
      .filter((board) => projects.has(board.projectId) && !deleted.has(board.projectId))
      .map((board) => [board.id, board]),
  )
  for (const project of projects.values()) {
    // Query every cloud-owned project even before workspace listeners hydrate RxDB.
    if (!online || project.ownerId !== uid || !remoteProjects?.docs.some((snapshot) => snapshot.id === project.id))
      continue
    const snapshots = await getDocs(
      query(collection(db!, 'users', uid!, 'projects', project.id, 'boards'), where('active', 'in', [true, false])),
    )
    for (const snapshot of snapshots.docs) {
      const remote = workspaceValue(snapshot.data()) as WorkspaceBoard
      if (remote.active === false) {
        boards.delete(snapshot.id)
        continue
      }
      boards.set(snapshot.id, {
        ...remote,
        scene: undefined,
        cloudStored: true,
        id: snapshot.id,
        projectId: project.id,
        project,
      })
    }
  }
  for (const board of shared?.boards ?? []) {
    const project = projects.get(board.projectId)
    if (project) boards.set(board.id, { ...board, project })
  }
  for (const board of shared?.directBoards ?? []) if (!boards.has(board.id)) boards.set(board.id, board)
  return [...boards.values()]
}

type Capture = { scenes: { scene: BoardScene; variant: '' | 'local' | 'cloud' }[]; localEdits: boolean }
async function capture(board: ExportBoard): Promise<Capture> {
  const uid = getFirebaseAuth()?.currentUser?.uid
  const owned = board.project.ownerId === (uid ?? 'local-user')
  const local = owned ? await workspaceStore.loadBoard(board.id) : null
  const localEdits = Boolean(local && local.syncStatus !== 'synced')
  let scene = local?.scene ?? board.scene
  let remoteRevision: number | undefined
  let cloudScene: BoardScene | undefined
  const db = getFirestoreDb()
  if (db && navigator.onLine) {
    // The private document supplies revision evidence; the share scene supplies live collaborative edits.
    const remote =
      uid && owned && (board.cloudStored || local?.syncStatus !== 'local-only')
        ? await getDoc(doc(db, 'users', uid, 'projects', board.projectId, 'boards', board.id))
        : null
    if (remote && (!remote.exists() || remote.data()?.active === false)) throw new Error('Board was deleted.')
    if (remote?.exists()) {
      const data = workspaceValue(remote.data()) as WorkspaceBoard
      cloudScene = data.scene
      remoteRevision = data.revision
    }
    const shared = await sharingService.getSharedBoard(board.id, getFirebaseAuth()?.currentUser?.email, uid)
    if (shared.status === 'restricted') throw new Error('Board access was revoked or the board was deleted.')
    if (shared.config?.scene) {
      const published = shared.config.scene
      cloudScene = cloudScene
        ? {
            ...published,
            elements: reconcileElementsLWW(cloudScene.elements, published.elements),
            files: { ...cloudScene.files, ...published.files },
          }
        : published
      const rtdb = getFirebaseRtdb()
      if (rtdb) {
        const elementsRef = ref(rtdb, `boards/${board.id}/elements`)
        let deltas
        try {
          deltas = await get(elementsRef)
        } catch (error) {
          const code = (error as { code?: string }).code?.toLowerCase()
          const denied =
            code?.includes('permission') ||
            (error instanceof Error && /^permission[_ -]denied[.!]?$/i.test(error.message))
          if (shared.config.ownerId !== uid || !denied) throw error
          // Older projections lack the new policy gates. Repair from the server policy,
          // then retry the authorized read; never discard live edits on a denied read.
          await projectCall('syncBoardAccessToRtdb', { boardId: board.id })
          deltas = await get(elementsRef)
        }
        cloudScene = {
          ...cloudScene,
          elements: mergeDeltaRecordsOntoBase(cloudScene.elements, Object.values(deltas.val() ?? {})),
        }
      }
    } else if (!owned) throw new Error('Board is no longer available.')
    scene = cloudScene ?? scene
  }
  if (!scene) throw new Error('Board has no readable scene.')
  const conflict =
    localEdits &&
    local &&
    (local.syncStatus === 'conflict' || (remoteRevision !== undefined && local.baseRevision !== remoteRevision))
  if (conflict) {
    if (!cloudScene) throw new Error('Connect to the internet to preserve both local and cloud conflict versions.')
    return {
      localEdits,
      scenes: [
        { variant: 'local', scene: await restoreSceneAssets(local.scene, local.scene.files) },
        { variant: 'cloud', scene: await restoreSceneAssets(cloudScene) },
      ],
    }
  }
  if (localEdits && local)
    scene = {
      ...scene,
      elements: reconcileElementsLWW(local.scene.elements, scene.elements),
      appState: local.scene.appState,
      files: { ...scene.files, ...local.scene.files },
    }
  return { scenes: [{ scene: await restoreSceneAssets(scene, local?.scene.files), variant: '' }], localEdits }
}

class ArchiveDownloadError extends Error {}

export async function exportBoards(options: {
  projectId?: string
  formats: ExportFormat[]
  includeShared?: boolean
  maxArchiveBytes?: number
  onArchiveReady?: (part: ExportResult, partNumber: number, multipart: boolean) => Promise<void>
  signal?: AbortSignal
  onProgress?: (completed: number, total: number) => void
  previous?: ExportResult
}): Promise<ExportResult> {
  if (!options.formats.length) throw new Error('Choose at least one format.')
  const identity = getFirebaseAuth()?.currentUser?.uid
  const boards = await enumerate(options.projectId, options.includeShared)
  const result: ExportResult = {
    files: { ...options.previous?.files },
    fileNames: [...(options.previous?.fileNames ?? [])],
    archiveCount: 0,
    failures: [],
    captures: [...(options.previous?.captures ?? [])],
  }
  const renderer = await import('@excalidraw/excalidraw')
  const limit = options.maxArchiveBytes ?? 256 * 1024 * 1024
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('Invalid archive size limit.')
  let pending: Record<string, Uint8Array> = {}
  let size = 0,
    completed = 0
  const ensureActive = () => {
    options.signal?.throwIfAborted()
    if (getFirebaseAuth()?.currentUser?.uid !== identity)
      throw new Error('Your account changed. Start the download again.')
  }
  const flush = async (final = false) => {
    if (!options.onArchiveReady || (!Object.keys(pending).length && (!final || result.archiveCount))) return
    ensureActive()
    const partNumber = result.archiveCount + 1
    try {
      await options.onArchiveReady({ ...result, files: pending }, partNumber, !final || partNumber > 1)
    } catch (cause) {
      throw new ArchiveDownloadError('ZIP download failed. Start the download again.', { cause })
    }
    ensureActive()
    result.archiveCount = partNumber
    pending = {}
    size = 0
  }
  // Serial rendering bounds canvas/image pressure; zip compression runs in a worker.
  for (const board of boards) {
    ensureActive()
    const formats = options.formats.filter(
      (format) =>
        !options.previous ||
        options.previous.failures.some((failure) => failure.boardId === board.id && failure.format === format),
    )
    if (!formats.length) {
      options.onProgress?.(++completed, boards.length)
      continue
    }
    try {
      const captured = await capture(board)
      ensureActive()
      result.captures = result.captures.filter((item) => item.boardId !== board.id)
      result.captures.push({
        boardId: board.id,
        name: board.name,
        capturedAt: new Date().toISOString(),
        localEdits: captured.localEdits,
        variants: captured.scenes.map((item) => item.variant || 'current'),
      })
      for (const { scene, variant } of captured.scenes) {
        const visible = scene.elements.filter((element) => !element.isDeleted)
        const elements = (
          visible.length
            ? visible
            : renderer.convertToExcalidrawElements([
                { type: 'rectangle', x: 0, y: 0, width: 800, height: 600, opacity: 0 },
              ])
        ) as any
        const files = (scene.files ?? {}) as any
        const appState = {
          ...scene.appState,
          exportBackground: true,
          exportWithDarkMode: false,
          viewBackgroundColor:
            !scene.appState.viewBackgroundColor || scene.appState.viewBackgroundColor === 'transparent'
              ? '#ffffff'
              : scene.appState.viewBackgroundColor,
        }
        for (const format of formats) {
          if (
            options.previous &&
            !options.previous.failures.some(
              (failure) =>
                failure.boardId === board.id &&
                failure.format === format &&
                (!failure.variant || failure.variant === variant),
            )
          )
            continue
          try {
            ensureActive()
            let output: Uint8Array
            if (format === 'excalidraw')
              output = new TextEncoder().encode(
                renderer.serializeAsJSON(scene.elements as any, scene.appState, files, 'local'),
              )
            else if (format === 'svg')
              output = new TextEncoder().encode((await renderer.exportToSvg({ elements, appState, files })).outerHTML)
            else
              output = new Uint8Array(
                await (
                  await renderer.exportToBlob({
                    elements,
                    appState,
                    files,
                    mimeType: 'image/png',
                    maxWidthOrHeight: 8192,
                  })
                ).arrayBuffer(),
              )
            ensureActive()
            if (output.byteLength > limit)
              throw new Error('This individual file exceeds the ZIP part size limit. Try another format.')
            if (size + output.byteLength > limit) await flush()
            ensureActive()
            size += output.byteLength
            const path = `${safeName(board.project.name)}-${board.projectId.slice(0, 8)}/${safeName(board.name)}-${board.id}${variant ? `-${variant}` : ''}.${format}`
            if (options.onArchiveReady) pending[path] = output
            else result.files[path] = output
            if (!result.fileNames.includes(path)) result.fileNames.push(path)
          } catch (error) {
            if (error instanceof ArchiveDownloadError) throw error
            ensureActive()
            result.failures.push({
              boardId: board.id,
              boardName: board.name,
              format,
              ...(variant ? { variant } : {}),
              message: error instanceof Error ? error.message : 'Export failed.',
            })
          }
        }
      }
    } catch (error) {
      if (error instanceof ArchiveDownloadError) throw error
      ensureActive()
      result.failures.push(
        ...formats.map((format) => ({
          boardId: board.id,
          boardName: board.name,
          format,
          message: error instanceof Error ? error.message : 'Board could not be loaded.',
        })),
      )
    }
    options.onProgress?.(++completed, boards.length)
  }
  // Deleted/revoked boards may no longer be enumerable on retry; retain their failures.
  for (const failure of options.previous?.failures ?? [])
    if (!boards.some((board) => board.id === failure.boardId)) result.failures.push(failure)
  await flush(true)
  return result
}

let activeDownloadUrl: string | undefined

export async function downloadExport(
  result: ExportResult,
  signal?: AbortSignal,
  name = 'my-boards',
  partNumber?: number,
) {
  const { zip, strToU8 } = await import('fflate')
  const archive = await new Promise<Uint8Array>((resolve, reject) =>
    zip(
      {
        ...result.files,
        'manifest.json': strToU8(
          JSON.stringify(
            {
              exportedAt: new Date().toISOString(),
              partNumber: partNumber ?? 1,
              files: Object.keys(result.files),
              allFiles: result.fileNames,
              captures: result.captures,
              failures: result.failures,
            },
            null,
            2,
          ),
        ),
      },
      { level: 6 },
      (error, bytes) => (error ? reject(error) : resolve(bytes)),
    ),
  )
  signal?.throwIfAborted()
  const url = URL.createObjectURL(new Blob([archive as Uint8Array<ArrayBuffer>], { type: 'application/zip' }))
  // The previous part has already started downloading; release its retained Blob.
  if (activeDownloadUrl) URL.revokeObjectURL(activeDownloadUrl)
  activeDownloadUrl = url
  const link = document.createElement('a')
  link.href = url
  link.download = `${safeName(name)}-${new Date().toISOString().slice(0, 10)}${partNumber ? `-part-${String(partNumber).padStart(3, '0')}` : ''}.zip`
  link.click()
  window.setTimeout(() => {
    URL.revokeObjectURL(url)
    if (activeDownloadUrl === url) activeDownloadUrl = undefined
  }, 60_000)
}
