/** Admin-only emulator setup for server-owned lifecycle flags; never runs against live Firebase. */
export async function patchEmulatorDocument(path: string, patch: Record<string, string | boolean | null>) {
  if (
    import.meta.env.VITE_USE_FIREBASE_EMULATOR !== 'true' ||
    import.meta.env.VITE_FIREBASE_PROJECT_ID !== 'demo-image-persistence'
  ) {
    throw new Error('Lifecycle fixture writes require the demo image emulators.')
  }
  const url = new URL(
    `http://${window.location.hostname}:8080/v1/projects/demo-image-persistence/databases/(default)/documents/${path}`,
  )
  const fields = Object.fromEntries(
    Object.entries(patch).map(([key, value]) => {
      url.searchParams.append('updateMask.fieldPaths', key)
      return [
        key,
        value === null
          ? { nullValue: null }
          : typeof value === 'boolean'
            ? { booleanValue: value }
            : { stringValue: value },
      ]
    }),
  )
  const result = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  })
  if (!result.ok) throw new Error(`Emulator fixture failed: ${result.status}`)
}
