export type SceneDeletionRecord = {
  id: string
  version: number
  versionNonce: number
  firstObservedDeletedAt: string
  compacted: boolean
}
type SceneState = { element?: any; deletion?: SceneDeletionRecord }
type Candidate = { id: string; version: number; versionNonce: number; element?: any; deletion?: SceneDeletionRecord }

function validateDeletionRecord(entry: SceneDeletionRecord, seen: Set<string>) {
  if (!entry || typeof entry.id !== 'string' || !entry.id || seen.has(entry.id) ||
      !Number.isSafeInteger(entry.version) || entry.version < 0 ||
      !Number.isSafeInteger(entry.versionNonce) || entry.versionNonce < 0 ||
      typeof entry.firstObservedDeletedAt !== 'string' || !Number.isFinite(Date.parse(entry.firstObservedDeletedAt)) ||
      typeof entry.compacted !== 'boolean')
    throw new Error('Invalid scene deletion ledger.')
  seen.add(entry.id)
}

function wins(candidate: Candidate, previous: Candidate): boolean {
  return candidate.version > previous.version ||
    (candidate.version === previous.version && candidate.versionNonce < previous.versionNonce)
}

/**
 * Reconcile live/full-tombstone elements with deletion metadata using the existing
 * higher-version/lower-nonce rule. Compact entries stay metadata and never become
 * partial elements passed to Excalidraw.
 */
export function reconcileElementsAndDeletionLedger(
  localElements: readonly any[] = [],
  remoteElements: readonly any[] = [],
  localLedger: readonly SceneDeletionRecord[] = [],
  remoteLedger: readonly SceneDeletionRecord[] = [],
): { elements: any[]; deletionLedger: SceneDeletionRecord[] } {
  const output = new Map<string, SceneState>()
  const stateCandidate = (state: SceneState): Candidate => {
    const source = state.element ?? state.deletion!
    return { id: source.id, version: Number(source.version ?? 0), versionNonce: Number(source.versionNonce ?? 0), ...state }
  }
  const mergeState = (candidate: SceneState) => {
    const incoming = stateCandidate(candidate), existing = output.get(incoming.id)
    if (!existing) {
      output.set(incoming.id, candidate)
      return
    }
    const previous = stateCandidate(existing)
    if (wins(incoming, previous)) {
      output.set(incoming.id, candidate)
      return
    }
    if (incoming.version === previous.version && incoming.versionNonce === previous.versionNonce &&
        incoming.deletion && previous.deletion && incoming.deletion.compacted === previous.deletion.compacted) {
      const earlier = Date.parse(incoming.deletion.firstObservedDeletedAt) < Date.parse(previous.deletion.firstObservedDeletedAt)
        ? incoming.deletion : previous.deletion
      output.set(incoming.id, { ...existing, deletion: earlier })
    } else if (incoming.version === previous.version && incoming.versionNonce === previous.versionNonce &&
        incoming.deletion?.compacted && existing.element?.isDeleted === true) {
      output.set(incoming.id, { deletion: incoming.deletion })
    } else if (incoming.version === previous.version && incoming.versionNonce === previous.versionNonce &&
        incoming.deletion && !incoming.deletion.compacted && existing.element?.isDeleted === true) {
      output.set(incoming.id, { ...existing, deletion: incoming.deletion })
    } else if (incoming.version === previous.version && incoming.versionNonce === previous.versionNonce &&
        previous.deletion?.compacted && incoming.element?.isDeleted === true) {
      // Same logical deletion; keep its compact representation instead of inflating it.
      output.set(incoming.id, existing)
    } else if (incoming.version === previous.version && incoming.versionNonce === previous.versionNonce &&
        previous.deletion && !previous.deletion.compacted && incoming.element?.isDeleted === true) {
      output.set(incoming.id, existing)
    }
  }
  const sideState = (elements: readonly any[], ledger: readonly SceneDeletionRecord[]): Map<string, SceneState> => {
    const side = new Map<string, SceneState>()
    for (const element of elements) {
      if (!element || typeof element.id !== 'string' || !element.id) continue
      const existing = side.get(element.id)
      if (!existing) side.set(element.id, { element })
      else {
        const previous = existing.element!
        const incoming = { id: element.id, version: Number(element.version ?? 0), versionNonce: Number(element.versionNonce ?? 0), element }
        const current = { id: previous.id, version: Number(previous.version ?? 0), versionNonce: Number(previous.versionNonce ?? 0), element: previous }
        if (wins(incoming, current)) side.set(element.id, { element })
      }
    }
    const seen = new Set<string>()
    for (const deletion of ledger) {
      validateDeletionRecord(deletion, seen)
      const element = side.get(deletion.id)?.element
      if (deletion.compacted) {
        if (element) throw new Error('A compact deletion cannot also contain its full element.')
        side.set(deletion.id, { deletion })
      } else {
        if (!element || element.isDeleted !== true || Number(element.version ?? 0) !== deletion.version ||
            Number(element.versionNonce ?? 0) !== deletion.versionNonce)
          throw new Error('An observed full tombstone must match its scene element.')
        side.set(deletion.id, { element, deletion })
      }
    }
    return side
  }
  for (const state of sideState(localElements, localLedger).values()) mergeState(state)
  for (const state of sideState(remoteElements, remoteLedger).values()) mergeState(state)
  return {
    elements: Array.from(output.values()).flatMap((state) => state.element ? [state.element] : []),
    deletionLedger: Array.from(output.values()).flatMap((state) => state.deletion ? [state.deletion] : []),
  }
}

/**
 * Attach server-observed timestamps to canonical full tombstones. Existing clocks
 * survive stale snapshots; a newer deletion starts a new clock at server time.
 */
export function observeSceneTombstones(
  baseElements: readonly any[],
  candidateElements: readonly any[],
  existingLedger: readonly SceneDeletionRecord[],
  serverNowMs: number,
): { elements: any[]; deletionLedger: SceneDeletionRecord[] } {
  if (!Number.isSafeInteger(serverNowMs) || serverNowMs < 0) throw new Error('Invalid server observation time.')
  const canonical = reconcileElementsAndDeletionLedger(baseElements, candidateElements, existingLedger, [])
  const known = new Map(canonical.deletionLedger.map((entry) => [entry.id, entry]))
  const deletionLedger = canonical.deletionLedger.slice()
  for (const element of canonical.elements) {
    if (element.isDeleted !== true) continue
    const previous = known.get(element.id)
    if (previous?.version === Number(element.version ?? 0) &&
        previous.versionNonce === Number(element.versionNonce ?? 0) && !previous.compacted) continue
    deletionLedger.push({ id: element.id, version: Number(element.version ?? 0),
      versionNonce: Number(element.versionNonce ?? 0), firstObservedDeletedAt: new Date(serverNowMs).toISOString(), compacted: false })
  }
  return { elements: canonical.elements, deletionLedger }
}

/** Compact only IDs authorized by a separate board-session admission fence. */
export function compactFencedTombstones(
  elements: readonly any[],
  deletionLedger: readonly SceneDeletionRecord[],
  sessionClosedIds: readonly string[],
): { elements: any[]; deletionLedger: SceneDeletionRecord[]; compactedIds: string[] } {
  const state = reconcileElementsAndDeletionLedger([], elements, [], deletionLedger)
  const byId = new Map(state.elements.map((element) => [element.id, element]))
  const authorizedIds = new Set(sessionClosedIds)
  const compactedIds: string[] = []
  const ledger = state.deletionLedger.map((record) => {
    if (record.compacted) return record
    if (!authorizedIds.has(record.id)) return record
    const element = byId.get(record.id)
    if (!element || element.isDeleted !== true || Number(element.version ?? 0) !== record.version ||
        Number(element.versionNonce ?? 0) !== record.versionNonce)
      throw new Error('Observed deletion does not match its full tombstone.')
    compactedIds.push(record.id)
    byId.delete(record.id)
    return { ...record, compacted: true }
  })
  return { elements: Array.from(byId.values()), deletionLedger: ledger, compactedIds }
}
