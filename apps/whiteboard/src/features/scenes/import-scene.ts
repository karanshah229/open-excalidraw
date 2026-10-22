import { reconcileElementsAndDeletionLedger, type SceneDeletionRecord } from '../collaboration/reconcile'

/** Turn an explicit file replacement into edits that survive element-level LWW sync. */
export function replaceSceneElements(current: readonly any[], imported: readonly any[], updated = Date.now()): any[] {
  const previous = new Map(current.map((element) => [element.id, element]))
  const importedIds = new Set(imported.map((element) => element.id))
  const edit = (element: any, previousVersion = 0) => ({
    ...element,
    version: Math.max(Number(element.version) || 0, previousVersion) + 1,
    versionNonce: Math.floor(Math.random() * 0x80000000),
    updated,
  })
  return [
    ...imported.map((element) => edit(element, Number(previous.get(element.id)?.version) || 0)),
    ...current
      .filter((element) => !importedIds.has(element.id))
      .map((element) => (element.isDeleted ? element : edit({ ...element, isDeleted: true }))),
  ]
}

/** Import replacement while retaining compact deletion metadata outside Excalidraw elements. */
export function replaceSceneElementsAndDeletionLedger(
  current: readonly any[],
  imported: readonly any[],
  deletionLedger: readonly SceneDeletionRecord[] = [],
  updated = Date.now(),
): { elements: any[]; deletionLedger: SceneDeletionRecord[] } {
  const ledgerById = new Map(deletionLedger.map((record) => [record.id, record]))
  const versionedImport = imported.map((element) => {
    const deletion = ledgerById.get(element?.id)
    return deletion ? { ...element, version: Math.max(Number(element.version) || 0, deletion.version + 1) } : element
  })
  const replacement = replaceSceneElements(current, versionedImport, updated)
  return reconcileElementsAndDeletionLedger(current, replacement, deletionLedger, [])
}
