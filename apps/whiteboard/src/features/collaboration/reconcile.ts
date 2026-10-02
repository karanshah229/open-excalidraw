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

/**
 * Produces a durable scene from a Firestore base and the latest RTDB records.
 * RTDB records are delta patches, not independent Excalidraw elements, so a
 * compactor must overlay a winning patch rather than replacing its base.
 */
export function mergeDeltaRecordsOntoBase(baseElements: readonly any[] = [], deltaRecords: readonly any[] = []): any[] {
  const elements = new Map<string, any>()
  for (const element of baseElements) {
    if (element?.id) elements.set(element.id, { ...element })
  }

  for (const record of deltaRecords) {
    if (!record?.id || typeof record.data !== 'string') continue
    let patch: any
    try {
      patch = JSON.parse(record.data)
    } catch {
      continue
    }
    if (!patch?.id || patch.id !== record.id) continue

    const existing = elements.get(patch.id)
    if (!existing) {
      // A new RTDB record is valid only when it is a complete element. This
      // avoids materializing corrupt partial patches after a crash.
      if (
        typeof patch.type !== 'string' ||
        typeof patch.x !== 'number' ||
        typeof patch.y !== 'number' ||
        typeof patch.width !== 'number' ||
        typeof patch.height !== 'number'
      ) {
        continue
      }
      elements.set(patch.id, patch)
      continue
    }

    const existingVersion = Number(existing.version ?? 0)
    const patchVersion = Number(patch.version ?? record.version ?? 0)
    const existingNonce = Number(existing.versionNonce ?? 0)
    const patchNonce = Number(patch.versionNonce ?? record.versionNonce ?? 0)
    const patchWins = patchVersion > existingVersion || (patchVersion === existingVersion && patchNonce < existingNonce)
    if (patchWins) elements.set(patch.id, { ...existing, ...patch })
  }

  return Array.from(elements.values())
}
