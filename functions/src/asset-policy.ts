export type AssetIdentity = { uid: string; token: Record<string, unknown> } | undefined

/** Missing flags are legacy active records; tombstones never grant image access. */
export function isAssetParentActive(data: Record<string, unknown> | undefined): boolean {
  return Boolean(data && data.active !== false && !data.deletedAt)
}

export function canAccessAsset(config: Record<string, any>, identity: AssetIdentity, write: boolean): boolean {
  if (!isAssetParentActive(config)) return false
  if (identity && identity.uid === config.ownerId) return true
  if (config.generalAccess === 'anyone_with_link' && (!write || config.generalRole === 'editor')) return true
  // An unverified email claim must not impersonate an invited collaborator.
  const email =
    identity?.token.email_verified === true && typeof identity.token.email === 'string'
      ? identity.token.email.toLowerCase()
      : undefined
  if (!email) return false
  return write
    ? config.collaborators?.[email]?.role === 'editor'
    : Boolean(config.invitedEmails?.includes(email) || config.collaborators?.[email])
}
