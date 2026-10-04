export type AssetIdentity = { uid: string; token: Record<string, unknown> } | undefined

/** Missing flags are legacy active records; tombstones never grant image access. */
export function isAssetParentActive(data: Record<string, unknown> | undefined): boolean {
  return Boolean(data && data.active !== false && !data.deletedAt)
}

/** Board grants and inherited project grants use the same live-policy gates. */
export function canAccessAsset(
  config: Record<string, any>,
  identity: AssetIdentity,
  write: boolean,
  parent?: Record<string, any>,
): boolean {
  if (!isAssetParentActive(config) || config.pending) return false
  if (parent && (!isAssetParentActive(parent) || parent.pending || parent.ownerId !== config.ownerId)) return false
  const allows = (policy: Record<string, any>) => {
    if (identity && identity.uid === policy.ownerId) return true
    if (policy.generalAccess === 'anyone_with_link' && (!write || policy.generalRole === 'editor')) return true
    const email =
      identity?.token.email_verified === true && typeof identity.token.email === 'string'
        ? identity.token.email.toLowerCase()
        : undefined
    if (!email || !policy.invitedEmails?.includes(email)) return false
    return !write || policy.collaborators?.[email]?.role === 'editor'
  }
  return allows(config) || Boolean(parent && config.inheritProjectAccess !== false && allows(parent))
}
