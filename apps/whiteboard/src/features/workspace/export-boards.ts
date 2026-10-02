import type { BoardScene } from '@agentic-whiteboard/storage'
import { collection, doc, getDocs, getDoc, query, where } from 'firebase/firestore'
import { get, ref } from 'firebase/database'
import { getFirebaseAuth, getFirebaseRtdb, getFirestoreDb } from '../../lib/firebase'
import { workspaceApi, workspaceStore, workspaceValue, type WorkspaceBoard } from './workspace-api'
import { sharingService } from '../sharing/sharing-service'
import { restoreSceneAssets } from '../assets/scene-assets'
import { mergeDeltaRecordsOntoBase, reconcileElementsLWW } from '../collaboration/reconcile'

export const exportFormats = ['excalidraw', 'svg', 'png'] as const
export type ExportFormat = (typeof exportFormats)[number]
export type ExportFailure = { boardId: string; boardName: string; format: ExportFormat; message: string }
export type ExportResult = {
  files: Record<string, Uint8Array>
  failures: ExportFailure[]
  captures: { boardId: string; name: string; capturedAt: string; localEdits: boolean }[]
}
// Strip control bytes and path separators from user-provided archive names.
const safeName = (value: string) =>
  value
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f<>:"/\\|?*]/g, '_')
    .replace(/^\.+|[. ]+$/g, '')
    .slice(0, 100) || 'Untitled'

async function enumerate(projectId?: string): Promise<WorkspaceBoard[]> {
  const workspace = await workspaceApi.listWorkspace(projectId)
  const uid = getFirebaseAuth()?.currentUser?.uid
  const owned = workspace.projects.filter(
    (project) => project.ownerId === uid || (!uid && project.ownerId === 'local-user'),
  )
  const projects = projectId ? workspace.projects.filter((project) => project.id === projectId) : owned
  const boards = new Map(
    workspace.boards
      .filter((board) => projects.some((project) => project.id === board.projectId))
      .map((board) => [board.id, board]),
  )
  const db = getFirestoreDb()
  if (db && uid && navigator.onLine) {
    for (const project of projects.filter((project) => project.ownerId === uid)) {
      const remoteProject = await getDoc(doc(db, 'users', uid, 'projects', project.id))
      // Local-only projects have no cloud parent yet; never query their private subcollection.
      if (!remoteProject.exists()) continue
      if (remoteProject.data().deletedAt) {
        for (const [id, board] of boards) if (board.projectId === project.id) boards.delete(id)
        continue
      }
      const snapshots = await getDocs(
        query(collection(db, 'users', uid, 'projects', project.id, 'boards'), where('active', '==', true)),
      )
      for (const snapshot of snapshots.docs) {
        const remote = workspaceValue(snapshot.data()) as WorkspaceBoard
        if (!boards.has(snapshot.id)) boards.set(snapshot.id, { ...remote, project })
      }
    }
  }
  return [...boards.values()]
}

async function capture(board: WorkspaceBoard): Promise<{ scene: BoardScene; localEdits: boolean }> {
  const local = await workspaceStore.loadBoard(board.id)
  const localEdits = Boolean(local && local.syncStatus !== 'synced')
  let scene = local?.scene ?? board.scene
  const db = getFirestoreDb(),
    uid = getFirebaseAuth()?.currentUser?.uid
  if (db && navigator.onLine) {
    const shared = await sharingService.getSharedBoard(board.id, getFirebaseAuth()?.currentUser?.email, uid)
    if (shared.status === 'restricted') throw new Error('Board access was revoked or the board was deleted.')
    if (shared.config?.scene) {
      scene = shared.config.scene
      const rtdb = getFirebaseRtdb()
      if (rtdb) {
        const deltas = await get(ref(rtdb, `boards/${board.id}/elements`))
        scene = { ...scene, elements: mergeDeltaRecordsOntoBase(scene.elements, Object.values(deltas.val() ?? {})) }
      }
    } else if (uid && board.project.ownerId === uid && local?.syncStatus !== 'local-only') {
      const remote = await getDoc(doc(db, 'users', uid, 'projects', board.projectId, 'boards', board.id))
      if (!remote.exists() || remote.data().active === false) throw new Error('Board was deleted.')
      scene = (workspaceValue(remote.data()) as WorkspaceBoard).scene
    }
  }
  if (!scene) throw new Error('Board has no readable scene.')
  if (localEdits && local)
    scene = {
      ...scene,
      elements: reconcileElementsLWW(local.scene.elements, scene.elements),
      appState: local.scene.appState,
      files: { ...scene.files, ...local.scene.files },
    }
  return { scene: await restoreSceneAssets(scene, local?.scene.files), localEdits }
}

export async function exportBoards(options: {
  projectId?: string
  formats: ExportFormat[]
  signal?: AbortSignal
  onProgress?: (completed: number, total: number) => void
  previous?: ExportResult
}): Promise<ExportResult> {
  if (!options.formats.length) throw new Error('Choose at least one format.')
  const identity = getFirebaseAuth()?.currentUser?.uid
  const boards = await enumerate(options.projectId)
  const result: ExportResult = {
    files: { ...options.previous?.files },
    failures: [],
    captures: [...(options.previous?.captures ?? [])],
  }
  const renderer = await import('@excalidraw/excalidraw')
  let size = Object.values(result.files).reduce((sum, file) => sum + file.byteLength, 0),
    completed = 0
  const ensureActive = () => {
    options.signal?.throwIfAborted()
    if (getFirebaseAuth()?.currentUser?.uid !== identity)
      throw new Error('Your account changed. Start the download again.')
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
      })
      const scene = captured.scene
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
          if (size + output.byteLength > 256 * 1024 * 1024)
            throw new Error('Download exceeds the 256 MB browser limit. Download smaller projects separately.')
          size += output.byteLength
          result.files[
            `${safeName(board.project.name)}-${board.projectId.slice(0, 8)}/${safeName(board.name)}-${board.id}.${format}`
          ] = output
        } catch (error) {
          ensureActive()
          result.failures.push({
            boardId: board.id,
            boardName: board.name,
            format,
            message: error instanceof Error ? error.message : 'Export failed.',
          })
        }
      }
    } catch (error) {
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
  return result
}

export async function downloadExport(result: ExportResult, signal?: AbortSignal, name = 'my-boards') {
  const { zip, strToU8 } = await import('fflate')
  const archive = await new Promise<Uint8Array>((resolve, reject) =>
    zip(
      {
        ...result.files,
        'manifest.json': strToU8(
          JSON.stringify(
            { exportedAt: new Date().toISOString(), captures: result.captures, failures: result.failures },
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
  const link = document.createElement('a')
  link.href = url
  link.download = `${safeName(name)}-${new Date().toISOString().slice(0, 10)}.zip`
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
