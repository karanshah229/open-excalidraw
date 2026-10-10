import { boardRole } from './access-role.js'
export type AssetIdentity = { uid: string; token: Record<string, unknown> } | undefined

/** Missing flags are legacy active records; tombstones never grant image access. */
export function isAssetParentActive(data: Record<string, unknown> | undefined): boolean {
  return Boolean(data && data.active !== false && !data.deletedAt)
}

/** Board grants and inherited project grants share one effective role resolver. */
export function canAccessAsset(
  config: Record<string, any>,
  identity: AssetIdentity,
  write: boolean,
  parent?: Record<string, any>,
): boolean {
  const email =
    identity?.token.email_verified === true && typeof identity.token.email === 'string'
      ? identity.token.email.toLowerCase()
      : undefined
  const role = boardRole(config, identity?.uid, email, parent)
  return Boolean(role && (!write || role === 'owner' || role === 'editor'))
}
export function canReadSpeakerNotes(
  config: Record<string, any>,
  identity: AssetIdentity,
  parent?: Record<string, any>,
): boolean {
  if (canAccessAsset(config, identity, true, parent)) return true
  if (!canAccessAsset(config, identity, false, parent)) return false
  const email =
    identity?.token.email_verified === true && typeof identity.token.email === 'string'
      ? identity.token.email.toLowerCase()
      : undefined
  const grants = (policy: Record<string, any>) =>
    (policy.generalAccess === 'anyone_with_link' && policy.generalRole === 'presentation') ||
    (email && policy.invitedEmails?.includes(email) && policy.collaborators?.[email]?.role === 'presentation')
  return Boolean(grants(config) || (parent && config.inheritProjectAccess !== false && grants(parent)))
}
