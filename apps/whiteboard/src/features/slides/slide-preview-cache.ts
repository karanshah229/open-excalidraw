/** A board-local cache. Components own display URLs; the cache retains only image bytes. */
export function createSlidePreviewCache(maxBytes = 32 * 1024 * 1024) {
  const entries = new Map<string, { key: string; blob: Blob }>()
  let bytes = 0
  function peek(slot: string) {
    const entry = entries.get(slot)
    if (entry) {
      entries.delete(slot)
      entries.set(slot, entry)
    }
    return entry
  }
  return {
    peek,
    get: (slot: string, key: string) => {
      const entry = peek(slot)
      return entry?.key === key ? entry.blob : undefined
    },
    put: (slot: string, key: string, blob: Blob) => {
      const previous = entries.get(slot)
      if (previous) {
        bytes -= previous.blob.size
        entries.delete(slot)
      }
      if (blob.size <= maxBytes) {
        entries.set(slot, { key, blob })
        bytes += blob.size
      }
      while (bytes > maxBytes) {
        const oldest = entries.entries().next().value!
        entries.delete(oldest[0])
        bytes -= oldest[1].blob.size
      }
    },
    clear: () => {
      entries.clear()
      bytes = 0
    },
  }
}
