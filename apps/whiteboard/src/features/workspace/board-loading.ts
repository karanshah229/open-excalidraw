/** Keep owner-local loading independent of a transient cloud access lookup. */
export async function resolveBoardSharing<T>(
  ownerId: string | undefined,
  userId: string | undefined,
  readSharing: () => Promise<T>,
): Promise<T | { status: 'not-found' | 'unavailable'; config?: never }> {
  if (!userId && ownerId === 'local-user') return { status: 'not-found' }
  try {
    return await readSharing()
  } catch (error) {
    const code = (error as { code?: string } | null)?.code
    const transient =
      code === 'unavailable' ||
      code === 'deadline-exceeded' ||
      (error instanceof Error && error.message === 'Firestore getDoc timeout')
    // A cached shared board is not proof of access. Only the current owner's
    // private workspace copy may be opened without a successful cloud lookup.
    if (userId && ownerId === userId && transient) return { status: 'unavailable' }
    throw error
  }
}
