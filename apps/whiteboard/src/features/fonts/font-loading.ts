import { loadCustomFonts } from '@excalidraw/excalidraw'
import { WHITEBOARD_FONTS } from './whiteboard-fonts'

export type FontLoadState = 'idle' | 'loading' | 'loaded' | 'error'
const bundled = WHITEBOARD_FONTS.filter((font) => font.uri !== 'local:')
const listeners = new Set<() => void>()
let snapshot = {
  online: navigator.onLine,
  states: Object.fromEntries(bundled.map((font) => [font.id, 'idle' as FontLoadState])),
}
const pending = new Map<number, Promise<boolean>>()
let backgroundStarted = false

function updateSnapshot() {
  const faces = [...document.fonts]
  const states = Object.fromEntries(
    bundled.map((font) => {
      const matching = faces.filter((face) => face.family.replace(/^["']|["']$/g, '') === font.family)
      const state: FontLoadState = matching.some((face) => face.status === 'loading')
        ? 'loading'
        : matching.some((face) => face.status === 'error')
          ? 'error'
          : matching.length && matching.every((face) => face.status === 'loaded')
            ? 'loaded'
            : 'idle'
      return [font.id, state]
    }),
  )
  if (snapshot.online === navigator.onLine && bundled.every((font) => snapshot.states[font.id] === states[font.id]))
    return
  snapshot = { online: navigator.onLine, states }
  for (const listener of listeners) listener()
}

export function getFontLoadSnapshot() {
  return snapshot
}

function onOnline() {
  updateSnapshot()
  if (backgroundStarted) void retryFailedFonts()
}

export function subscribeToFontLoading(listener: () => void) {
  if (!listeners.size) {
    document.fonts.addEventListener('loading', updateSnapshot)
    document.fonts.addEventListener('loadingdone', updateSnapshot)
    document.fonts.addEventListener('loadingerror', updateSnapshot)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', updateSnapshot)
  }
  listeners.add(listener)
  updateSnapshot()
  return () => {
    listeners.delete(listener)
    if (!listeners.size) {
      document.fonts.removeEventListener('loading', updateSnapshot)
      document.fonts.removeEventListener('loadingdone', updateSnapshot)
      document.fonts.removeEventListener('loadingerror', updateSnapshot)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', updateSnapshot)
    }
  }
}

async function loadQueue(ids: number[], retry = false) {
  let next = 0
  async function worker() {
    while (next < ids.length) {
      const id = ids[next++]
      let task = pending.get(id)
      if (!task) {
        task = loadCustomFonts([id], retry)
        pending.set(id, task)
        updateSnapshot()
      }
      try {
        await task
      } finally {
        pending.delete(id)
        updateSnapshot()
      }
    }
  }
  await Promise.all([worker(), worker()])
}

export function retryFailedFonts() {
  updateSnapshot()
  return loadQueue(
    bundled.filter((font) => snapshot.states[font.id] === 'error').map((font) => font.id),
    true,
  )
}

// Wait for the editor's first paint, then use idle time; never gate rendering on fonts.
export function scheduleWhiteboardFontPreload() {
  if (backgroundStarted) return () => {}
  let cancelled = false
  let frame = 0
  let idle: number | undefined
  let timer: number | undefined
  const start = () => {
    if (cancelled || backgroundStarted) return
    backgroundStarted = true
    void loadQueue(bundled.map((font) => font.id))
  }
  frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(() => {
      if (typeof window.requestIdleCallback === 'function') idle = window.requestIdleCallback(start, { timeout: 3000 })
      else timer = window.setTimeout(start, 1000)
    })
  })
  return () => {
    cancelled = true
    cancelAnimationFrame(frame)
    if (idle !== undefined) window.cancelIdleCallback(idle)
    if (timer !== undefined) window.clearTimeout(timer)
  }
}
