/**
 * Reconciles two sets of Excalidraw elements using element-level Last-Write-Wins (LWW)
 * with deterministic versionNonce tie-breaking (aligned with Excalidraw's engine standard).
 */
export function reconcileElementsLWW(localElements: readonly any[] = [], remoteElements: readonly any[] = []): any[] {
  const elementMap = new Map<string, any>()

  // 1. Index local elements
  for (const el of localElements) {
    if (el && el.id) {
      elementMap.set(el.id, el)
    }
  }

  // 2. Reconcile with remote elements
  for (const remoteEl of remoteElements) {
    if (!remoteEl || !remoteEl.id) continue
    const localEl = elementMap.get(remoteEl.id)
    if (!localEl) {
      elementMap.set(remoteEl.id, remoteEl)
      continue
    }

    const localVer = Number(localEl.version ?? 0)
    const remoteVer = Number(remoteEl.version ?? 0)
    const localNonce = Number(localEl.versionNonce ?? 0)
    const remoteNonce = Number(remoteEl.versionNonce ?? 0)

    if (remoteVer > localVer) {
      elementMap.set(remoteEl.id, remoteEl)
    } else if (remoteVer === localVer) {
      // Deterministic tie-break: lowest versionNonce wins (Excalidraw standard)
      if (remoteNonce < localNonce) {
        elementMap.set(remoteEl.id, remoteEl)
      }
    }
    // Else localVer > remoteVer (or local has lower nonce), keep local
  }

  return Array.from(elementMap.values())
}
