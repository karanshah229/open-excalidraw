// Uses the current Firebase CLI login; never persists or prints access tokens.
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'

export const projectId = 'open-excalidraw-dev-2'
const cliPath = realpathSync(execFileSync('which', ['firebase'], { encoding: 'utf8' }).trim())
const cli = createRequire(cliPath)
const cliAuth = cli(join(dirname(cliPath), '../auth.js'))
const cliApi = cli(join(dirname(cliPath), '../api.js'))
cliApi.setScopes(['https://www.googleapis.com/auth/cloud-platform'])
const account = cliAuth.getProjectDefaultAccount(projectId) ?? cliAuth.getGlobalDefaultAccount()
if (!account) throw new Error('Sign in to the Firebase CLI before running live dev tests.')
export async function accessToken() {
  return (await cliAuth.getAccessToken(account.tokens.refresh_token, cliApi.getScopes())).access_token
}
export async function adminFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', ...options.headers },
  })
  const result = await response.json()
  if (!response.ok && response.status !== 404)
    throw new Error(`Admin request failed (${response.status}): ${result.error?.message}`)
  return response.status === 404 ? null : result
}
const root = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`
function encode(value) {
  if (value === null) return { nullValue: null }
  if (typeof value === 'boolean') return { booleanValue: value }
  if (typeof value === 'number')
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value }
  if (typeof value === 'string') return { stringValue: value }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } }
  return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)])) } }
}
function decode(value) {
  if ('integerValue' in value) return Number(value.integerValue)
  if ('doubleValue' in value) return value.doubleValue
  if ('arrayValue' in value) return (value.arrayValue.values ?? []).map(decode)
  if ('mapValue' in value)
    return Object.fromEntries(Object.entries(value.mapValue.fields ?? {}).map(([key, item]) => [key, decode(item)]))
  return Object.values(value)[0]
}
export async function readDocument(path) {
  const document = await adminFetch(`${root}/${path}`)
  return document
    ? {
        data: Object.fromEntries(Object.entries(document.fields ?? {}).map(([key, item]) => [key, decode(item)])),
        raw: document,
      }
    : null
}
export async function patchDocument(path, data) {
  const mask = Object.keys(data)
    .map((field) => `updateMask.fieldPaths=${encodeURIComponent(field)}`)
    .join('&')
  return adminFetch(`${root}/${path}?${mask}`, {
    method: 'PATCH',
    body: JSON.stringify({ fields: encode(data).mapValue.fields }),
  })
}
export async function deleteTree(path) {
  const children = await adminFetch(`${root}/${path}:listCollectionIds`, {
    method: 'POST',
    body: JSON.stringify({ pageSize: 100 }),
  })
  for (const collection of children?.collectionIds ?? []) {
    let pageToken
    do {
      const page = await adminFetch(
        `${root}/${path}/${collection}?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
      )
      for (const document of page?.documents ?? []) await deleteTree(document.name.split('/documents/')[1])
      pageToken = page?.nextPageToken
    } while (pageToken)
  }
  await adminFetch(`${root}/${path}`, { method: 'DELETE' })
}
// Optimistic preconditions preserve concurrent family-list edits from other worktrees.
export async function complimentaryFixture(email, present) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const current = await readDocument('adminConfig/complimentaryUsers')
    const emails = (current?.data.emails ?? []).filter((entry) => entry !== email)
    if (present) emails.push(email)
    const result = await fetch(
      `${root}/adminConfig/complimentaryUsers?updateMask.fieldPaths=emails&currentDocument.${current ? `updateTime=${encodeURIComponent(current.raw.updateTime)}` : 'exists=false'}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { emails: encode(emails) } }),
      },
    )
    if (result.ok) return
    if (![409, 400].includes(result.status))
      throw new Error(`Could not update fixture complimentary membership: ${result.status}`)
  }
  throw new Error('Concurrent edits prevented the temporary complimentary-list update.')
}
const ar = createRequire(new URL('../functions/package.json', import.meta.url))
const aa = ar('firebase-admin/app')
const app = aa.initializeApp(
  {
    projectId,
    serviceAccountId: '915263627491-compute@developer.gserviceaccount.com',
    credential: {
      async getAccessToken() {
        return { access_token: await accessToken(), expires_in: 3600 }
      },
    },
  },
  'freemium-live-tests',
)
export const adminAuth = ar('firebase-admin/auth').getAuth(app)
export const closeAdmin = () => aa.deleteApp(app)

// Owner CLI credentials can create keys but cannot remotely sign blobs. Keep a
// short-lived fixture signer solely in memory and revoke it immediately after
// Firebase exchanges the custom token. Do not change Auth providers or IAM roles.
export async function fixtureToken(uid, otherUids = []) {
  const account = `projects/${projectId}/serviceAccounts/firebase-adminsdk-fbsvc@${projectId}.iam.gserviceaccount.com`
  const key = await adminFetch(`https://iam.googleapis.com/v1/${account}/keys`, {
    method: 'POST',
    body: JSON.stringify({ privateKeyType: 'TYPE_GOOGLE_CREDENTIALS_FILE', keyAlgorithm: 'KEY_ALG_RSA_2048' }),
  })
  const credentials = JSON.parse(Buffer.from(key.privateKeyData, 'base64').toString('utf8'))
  const signer = aa.initializeApp({ projectId, credential: aa.cert(credentials) }, `fixture-signer-${uid}`)
  const revoke = async () => {
    await adminFetch(`https://iam.googleapis.com/v1/${key.name}`, { method: 'DELETE' })
    await aa.deleteApp(signer)
  }
  try {
    const auth = ar('firebase-admin/auth').getAuth(signer)
    const tokens = Object.fromEntries(
      await Promise.all([uid, ...otherUids].map(async (id) => [id, await auth.createCustomToken(id)])),
    )
    return { token: tokens[uid], tokens, revoke }
  } catch (error) {
    await revoke()
    throw error
  }
}
