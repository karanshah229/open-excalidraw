/** Durable cross-store generation-reset protocol shared by reset and recovery workers. */
export type GenerationResetPhase = 'prepared' | 'fenced' | 'published' | 'activated' | 'cancelled'

export type GenerationResetRecord = {
  operationId: string
  token: string
  phase: GenerationResetPhase
  sourceGeneration: number
  targetGeneration: number
  sourceHeadRevisionId: string
  targetHeadRevisionId?: string
}

export type GenerationResetObservation = {
  headGeneration: number
  headRevisionId: string
  roomGeneration: number | null
  admissionClosed: boolean
  admissionOwner: string | null
}

export type GenerationResetAction = 'close-admission' | 'fence-room' | 'publish-target' | 'activate-target' | 'reopen-admission' | 'cancel' | 'complete'

function invalid(message: string): never {
  throw new Error(`Invalid generation reset state: ${message}`)
}

/**
 * Derive the only safe next operation after a worker restart. In particular, once
 * Firestore has published G+1, recovery must finish RTDB activation; it cannot roll
 * the head back or reopen admission to G.
 */
export function nextGenerationResetAction(
  record: GenerationResetRecord,
  observation: GenerationResetObservation,
): GenerationResetAction {
  if (!record.operationId || !record.token || !record.sourceHeadRevisionId ||
      !Number.isSafeInteger(record.sourceGeneration) || record.sourceGeneration < 1 ||
      record.targetGeneration !== record.sourceGeneration + 1)
    invalid('malformed operation record')

  switch (record.phase) {
    case 'prepared':
      if (observation.headGeneration !== record.sourceGeneration ||
          observation.headRevisionId !== record.sourceHeadRevisionId)
        invalid('source head changed before fencing')
      return observation.admissionClosed && observation.admissionOwner === record.token
        ? 'fence-room'
        : 'close-admission'
    case 'fenced':
      if (!observation.admissionClosed || observation.admissionOwner !== record.token)
        invalid('fenced operation lost RTDB admission ownership')
      if (observation.headGeneration === record.sourceGeneration &&
          observation.headRevisionId === record.sourceHeadRevisionId)
        return observation.roomGeneration === record.targetGeneration ? 'publish-target' : 'fence-room'
      if (observation.headGeneration === record.targetGeneration &&
          observation.headRevisionId === record.targetHeadRevisionId)
        return 'activate-target'
      return invalid('Firestore head does not match source or prepared target')
    case 'published':
      if (observation.headGeneration !== record.targetGeneration ||
          !record.targetHeadRevisionId || observation.headRevisionId !== record.targetHeadRevisionId)
        return invalid('published target does not match Firestore head')
      if (!observation.admissionClosed || observation.admissionOwner !== record.token)
        return invalid('published operation no longer owns the closed RTDB gate')
      return observation.roomGeneration === record.targetGeneration ? 'reopen-admission' : 'activate-target'
    case 'activated':
      if (observation.headGeneration !== record.targetGeneration ||
          observation.headRevisionId !== record.targetHeadRevisionId ||
          observation.roomGeneration !== record.targetGeneration)
        return invalid('activated generation is inconsistent across stores')
      return observation.admissionClosed && observation.admissionOwner === record.token
        ? 'reopen-admission'
        : 'complete'
    case 'cancelled':
      if (observation.headGeneration !== record.sourceGeneration ||
          observation.headRevisionId !== record.sourceHeadRevisionId)
        return invalid('cancelled operation cannot follow a published head')
      return observation.admissionClosed && observation.admissionOwner === record.token
        ? 'reopen-admission'
        : 'complete'
  }
}

/** Check whether a phase update is legal and idempotent for the owning worker. */
export function assertGenerationResetAdvance(
  record: GenerationResetRecord,
  token: string,
  next: GenerationResetPhase,
): void {
  if (!token || token !== record.token) invalid('worker token does not own operation')
  if (record.phase === next) return
  const allowed: Record<GenerationResetPhase, GenerationResetPhase[]> = {
    prepared: ['fenced', 'cancelled'],
    fenced: ['published', 'cancelled'],
    published: ['activated'],
    activated: [],
    cancelled: [],
  }
  if (!allowed[record.phase].includes(next)) invalid(`cannot advance ${record.phase} to ${next}`)
}
