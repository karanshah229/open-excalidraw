export type AccessRole = 'owner' | 'editor' | 'viewer' | 'presentation'
export type AccessPolicy = Record<string, any>
export const roleRank: Record<AccessRole, number> = { owner: 4, editor: 3, viewer: 2, presentation: 1 }
export function strongestRole(...roles: (AccessRole | null | undefined)[]): AccessRole | null {
  return roles.reduce<AccessRole | null>(
    (best, role) => (role && roleRank[role] !== undefined && (!best || roleRank[role] > roleRank[best]) ? role : best),
    null,
  )
}
export function policyRole(policy: AccessPolicy | undefined, uid?: string, email?: string): AccessRole | null {
  if (!policy || policy.deletedAt || policy.active === false) return null
  if (uid && policy.ownerId === uid) return 'owner'
  if (policy.pending) return null
  const direct =
    email && policy.invitedEmails?.includes(email) ? (policy.collaborators?.[email]?.role ?? 'viewer') : null
  const general = policy.generalAccess === 'anyone_with_link' ? (policy.generalRole ?? 'viewer') : null
  return strongestRole(direct, general)
}
export function boardRole(
  policy: AccessPolicy,
  uid?: string,
  email?: string,
  parent?: AccessPolicy,
): AccessRole | null {
  if (policy.deletedAt || policy.active === false || (policy.pending && policy.ownerId !== uid)) return null
  if (
    parent &&
    (parent.deletedAt ||
      parent.active === false ||
      parent.ownerId !== policy.ownerId ||
      (parent.pending && parent.ownerId !== uid))
  )
    return null
  return strongestRole(
    policyRole(policy, uid, email),
    policy.inheritProjectAccess !== false ? policyRole(parent, uid, email) : null,
  )
}
