/** Independent read-only REST inspector for the explicitly selected dev project. */
import { execFileSync } from 'node:child_process'
const project = 'open-excalidraw-dev-2'
if (process.env.GCLOUD_PROJECT !== project || process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_DATABASE_EMULATOR_HOST) throw new Error('Live inspector requires explicit dev project and no emulators')
const firestore = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`
const database = `https://${project}-default-rtdb.firebaseio.com`
let token, expires = 0
const cache = new Map()
export const inspection = { requests: 0, cacheHits: 0 }
async function request(url, missing = false) {
  let res
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!token || Date.now() > expires) {
      token = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim()
      expires = Date.now() + 45 * 60 * 1000
    }
    inspection.requests++
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (res.status !== 401 || attempt === 1) break
    // A long-running live test can outlast the OAuth token despite our cache
    // window. Refresh once on the authoritative 401; never hide other failures.
    token = undefined
    expires = 0
  }
  if (missing && res.status === 404) return null
  if (!res.ok) throw new Error(`Dev Firebase read failed (${res.status}): ${(await res.json()).error?.message ?? 'API error'}`)
  return res.json()
}
function decode(value) {
  if ('mapValue' in value) return Object.fromEntries(Object.entries(value.mapValue.fields ?? {}).map(([k, v]) => [k, decode(v)]))
  if ('arrayValue' in value) return (value.arrayValue.values ?? []).map(decode)
  if ('integerValue' in value) return Number(value.integerValue)
  if ('doubleValue' in value) return value.doubleValue
  if ('timestampValue' in value) { const iso = value.timestampValue; return { toDate: () => new Date(iso), toJSON: () => iso } }
  if ('nullValue' in value) return null
  return Object.values(value)[0]
}
const snapshot = doc => ({ id: doc?.name.split('/').at(-1), data: () => doc ? decode({ mapValue: { fields: doc.fields } }) : undefined })
export const db = {
  doc(path) { return { async get() {
    const immutable = /\/(chunks|revisions|noteRevisions|versions)\//.test(path)
    if (immutable && cache.has(path)) { inspection.cacheHits++; return snapshot(cache.get(path)) }
    const doc = await request(`${firestore}/${path}`, true)
    if (immutable && doc) cache.set(path, doc)
    return snapshot(doc)
  } } },
  collection(path) { return { async get() {
    const docs = []; let next
    do { const result = await request(`${firestore}/${path}?pageSize=1000${next ? `&pageToken=${encodeURIComponent(next)}` : ''}`); docs.push(...(result.documents ?? []).map(snapshot)); next = result.nextPageToken } while (next)
    return { docs, size: docs.length }
  } } },
  async terminate() {},
}
export const rtdb = { ref(path) { return { async get() { const value = await request(`${database}/${path}.json`); return { val: () => value } } } } }
