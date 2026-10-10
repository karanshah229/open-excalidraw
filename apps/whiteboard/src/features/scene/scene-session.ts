import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types'

export type SceneSnapshot = {
  elements: readonly ExcalidrawElement[]
  files: BinaryFiles
  background: string
  theme: AppState['theme']
}

/** Observation is independent of permission and save gating, including remote updates. */
export function createSceneSession() {
  let snapshot: SceneSnapshot = { elements: [], files: {}, background: '#ffffff', theme: 'light' }
  let fingerprint = ''
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    publish: (
      elements: readonly ExcalidrawElement[],
      appState: Pick<AppState, 'viewBackgroundColor'> & Partial<Pick<AppState, 'theme'>>,
      files: BinaryFiles,
    ) => {
      const next = `${appState.theme ?? 'light'}|${appState.viewBackgroundColor}|${elements.map((e) => `${e.id}:${e.version}:${e.versionNonce}:${e.isDeleted}`).join('|')}|${Object.values(
        files,
      )
        .map((f) => `${f.id}:${!!f.dataURL}`)
        .join('|')}`
      if (fingerprint === next) return
      fingerprint = next
      snapshot = {
        elements: [...elements],
        files: { ...files },
        background: appState.viewBackgroundColor || '#ffffff',
        theme: appState.theme ?? 'light',
      }
      listeners.forEach((listener) => listener())
    },
  }
}
