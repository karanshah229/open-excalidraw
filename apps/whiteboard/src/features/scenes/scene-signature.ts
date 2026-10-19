/** Stable dirty-check signature for persisted board scene content. */
export function getSceneSignature(
  scene?: { elements?: readonly any[]; appState?: any; files?: Record<string, any> } | null,
): string {
  if (!scene) return ''
  const normalizedAppState = {
    theme: scene.appState?.theme,
    viewBackgroundColor: scene.appState?.viewBackgroundColor,
    gridModeEnabled: scene.appState?.gridModeEnabled,
    objectsSnapModeEnabled: scene.appState?.objectsSnapModeEnabled,
  }
  return JSON.stringify(
    {
      elements: scene.elements || [],
      appState: normalizedAppState,
      // File IDs identify immutable content; avoid serializing image bytes on every change.
      files: Object.keys(scene.files ?? {})
        .sort()
        .map((id) => {
          const file = scene.files![id]
          return [id, file.mimeType, Boolean(file.dataURL)]
        }),
    },
    (key, value) => (key === 'updated' ? undefined : value),
  )
}
