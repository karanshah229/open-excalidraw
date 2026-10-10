import type { Reference } from 'firebase-admin/database'
import { canonicalStringify } from './scene-codec.js'

/** Conditional per-record pruning preserves replacements and reconnects. */
export async function pruneCheckpointedRecords(
  elementsRef: Reference,
  presenceRef: Reference,
  captured: Record<string, Record<string, unknown>>,
) {
  for (const [key, record] of Object.entries(captured)) {
    if ((await presenceRef.get()).exists()) break
    await elementsRef.child(key).transaction((current) => {
      // An uninitialized RTDB transaction cache first supplies null. Submit the
      // empty compare-and-set so the server retries with its actual record;
      // aborting here would leave every cold-worker record unpruned.
      if (current == null) return null
      if (canonicalStringify(current) === canonicalStringify(record)) return null
      return undefined
    })
  }
}
