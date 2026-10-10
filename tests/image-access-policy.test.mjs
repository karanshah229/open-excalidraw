import assert from 'node:assert/strict'
import { canAccessAsset, isAssetParentActive } from '../functions/lib/asset-policy.js'

const config = {
  ownerId: 'owner',
  generalAccess: 'restricted',
  generalRole: 'viewer',
  invitedEmails: ['viewer@example.com', 'editor@example.com'],
  collaborators: { 'editor@example.com': { role: 'editor' } },
}
const owner = { uid: 'owner', token: {} }
const invited = (email) => ({ uid: email, token: { email, email_verified: true } })
assert.equal(canAccessAsset(config, owner, true), true)
assert.equal(canAccessAsset(config, undefined, false), false)
assert.equal(canAccessAsset({ ...config, ownerId: undefined }, undefined, false), false)
assert.equal(canAccessAsset(config, invited('outsider@example.com'), false), false)
assert.equal(canAccessAsset(config, invited('viewer@example.com'), false), true)
assert.equal(canAccessAsset(config, invited('viewer@example.com'), true), false)
assert.equal(canAccessAsset(config, invited('EDITOR@example.com'), true), true)
assert.equal(
  canAccessAsset(config, { uid: 'impostor', token: { email: 'editor@example.com', email_verified: false } }, true),
  false,
)
assert.equal(canAccessAsset({ ...config, generalAccess: 'anyone_with_link' }, undefined, false), true)
assert.equal(canAccessAsset({ ...config, generalAccess: 'anyone_with_link' }, undefined, true), false)
assert.equal(
  canAccessAsset({ ...config, generalAccess: 'anyone_with_link', generalRole: 'editor' }, undefined, true),
  true,
)
for (const tombstone of [{ active: false }, { deletedAt: '2026-10-03T00:00:00Z' }]) {
  assert.equal(canAccessAsset({ ...config, ...tombstone }, owner, false), false)
  assert.equal(canAccessAsset({ ...config, generalAccess: 'anyone_with_link', ...tombstone }, undefined, false), false)
  if (!tombstone.pending) assert.equal(isAssetParentActive(tombstone), false)
}
assert.equal(isAssetParentActive(undefined), false)
assert.equal(isAssetParentActive({}), true)
console.log('PASS: owner, invited viewer/editor, verified email, public roles, and soft-delete access policies')

const parent = { ...config, generalAccess: 'anyone_with_link', generalRole: 'editor' }
assert.equal(canAccessAsset(config, undefined, false, parent), true)
assert.equal(canAccessAsset(config, undefined, true, parent), true)
assert.equal(canAccessAsset({ ...config, inheritProjectAccess: false }, undefined, false, parent), false)
for (const gate of [{ deletedAt: 'deleted' }, { ownerId: 'foreign-owner' }]) {
  assert.equal(canAccessAsset(config, owner, false, { ...parent, ...gate }), false)
}
console.log('PASS: inherited project roles, custom board grants, pending gates, and owner binding')

assert.equal(canAccessAsset({ ...config, pending: true }, owner, true), true)
assert.equal(canAccessAsset({ ...config, pending: true }, invited('editor@example.com'), true), false)
assert.equal(canAccessAsset(config, owner, true, { ...parent, pending: true }), true)
assert.equal(
  canAccessAsset({ ...config, generalAccess: 'anyone_with_link', generalRole: 'presentation' }, undefined, false),
  true,
)
assert.equal(
  canAccessAsset({ ...config, generalAccess: 'anyone_with_link', generalRole: 'presentation' }, undefined, true),
  false,
)
