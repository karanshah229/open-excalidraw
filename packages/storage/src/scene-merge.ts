import type { BoardScene } from './index'

/** Merge two scene snapshots while preserving versioned deletion-ledger state. */
export function mergeBoardScenes(local: BoardScene, remote: BoardScene): BoardScene {
  type LedgerEntry = NonNullable<BoardScene['deletionLedger']>[number]
  type State = { element?: Record<string, unknown>; deletion?: LedgerEntry }
  const states = new Map<string, State>()
  const compareAndMerge = (incoming: State) => {
    const candidate = incoming.element ?? incoming.deletion!
    const id = String(candidate.id)
    const current = states.get(id)
    if (!current) { states.set(id, incoming); return }
    const previous = current.element ?? current.deletion!
    const candidateVersion = Number(candidate.version ?? 0), previousVersion = Number(previous.version ?? 0)
    const candidateNonce = Number(candidate.versionNonce ?? 0), previousNonce = Number(previous.versionNonce ?? 0)
    if (candidateVersion > previousVersion || (candidateVersion === previousVersion && candidateNonce < previousNonce)) {
      states.set(id, incoming)
    } else if (candidateVersion === previousVersion && candidateNonce === previousNonce && incoming.deletion && current.deletion &&
        incoming.deletion.compacted === current.deletion.compacted &&
        Date.parse(incoming.deletion.firstObservedDeletedAt) < Date.parse(current.deletion.firstObservedDeletedAt)) {
      states.set(id, { ...current, deletion: incoming.deletion })
    } else if (candidateVersion === previousVersion && candidateNonce === previousNonce && incoming.deletion?.compacted &&
        current.element?.isDeleted === true) {
      states.set(id, { deletion: incoming.deletion })
    } else if (candidateVersion === previousVersion && candidateNonce === previousNonce && incoming.deletion &&
        !incoming.deletion.compacted && current.element?.isDeleted === true) {
      states.set(id, { ...current, deletion: incoming.deletion })
    } else if (candidateVersion === previousVersion && candidateNonce === previousNonce && current.deletion?.compacted &&
        incoming.element?.isDeleted === true) {
      // Equivalent full tombstones cannot inflate a canonical compact record.
    } else if (candidateVersion === previousVersion && candidateNonce === previousNonce && current.deletion &&
        !current.deletion.compacted && incoming.element?.isDeleted === true) {
      // Preserve the server-observed deletion clock attached to this same tombstone.
    }
  }
  const addSide = (scene: BoardScene) => {
    const seen = new Set<string>()
    for (const entry of scene.deletionLedger ?? []) {
      if (!entry || typeof entry.id !== 'string' || !entry.id || seen.has(entry.id) ||
          !Number.isSafeInteger(entry.version) || entry.version < 0 ||
          !Number.isSafeInteger(entry.versionNonce) || entry.versionNonce < 0 ||
          typeof entry.firstObservedDeletedAt !== 'string' || !Number.isFinite(Date.parse(entry.firstObservedDeletedAt)) ||
          typeof entry.compacted !== 'boolean') throw new Error('Invalid board scene deletion ledger.')
      seen.add(entry.id)
    }
    const side = new Map<string, State>()
    for (const element of scene.elements ?? []) if (element && typeof element.id === 'string' && element.id)
      side.set(element.id, { element })
    for (const deletion of scene.deletionLedger ?? []) {
      const element = side.get(deletion.id)?.element
      if (deletion.compacted && element) throw new Error('A compact deletion cannot also contain its full element.')
      if (!deletion.compacted && (!element || element.isDeleted !== true || Number(element.version ?? 0) !== deletion.version ||
          Number(element.versionNonce ?? 0) !== deletion.versionNonce))
        throw new Error('An observed full tombstone must match its scene element.')
      side.set(deletion.id, { element, deletion })
    }
    for (const state of side.values()) compareAndMerge(state)
  }
  addSide(local)
  addSide(remote)
  return { ...remote, ...local,
    elements: Array.from(states.values()).flatMap((state) => state.element ? [state.element] : []),
    deletionLedger: Array.from(states.values()).flatMap((state) => state.deletion ? [state.deletion] : []),
    files: { ...remote.files, ...local.files } }
}
