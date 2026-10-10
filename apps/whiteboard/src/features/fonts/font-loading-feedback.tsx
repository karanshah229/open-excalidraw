import { useEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { getFontLoadSnapshot, retryFailedFonts, subscribeToFontLoading } from './font-loading'
import { WHITEBOARD_FONTS } from './whiteboard-fonts'

export function FontLoadingFeedback() {
  const { online, states } = useSyncExternalStore(subscribeToFontLoading, getFontLoadSnapshot)
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const loading = Object.values(states).some((state) => state === 'loading')
  const failed = Object.values(states).some((state) => state === 'error')

  useEffect(() => {
    const findPicker = () => setContainer(document.querySelector<HTMLElement>('.properties-content:has(.fonts)'))
    const observer = new MutationObserver(findPicker)
    observer.observe(document.body, { childList: true, subtree: true })
    findPicker()
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!container) return
    container.dataset.fontsLoading = String(loading)
    for (const button of container.querySelectorAll<HTMLButtonElement>('.fonts button')) {
      const font = WHITEBOARD_FONTS.find((font) => font.id === Number(button.value))
      if (!font || font.uri === 'local:') continue
      const state = states[font.id]
      button.dataset.fontLoadState = state
      button.setAttribute('aria-busy', String(state === 'loading'))
      button.title =
        state === 'error'
          ? `${font.family} unavailable. Using a ${font.genericFamily} fallback.`
          : state === 'loading'
            ? `Loading ${font.family}…`
            : font.family
    }
  }, [container, states, loading])

  if (!container || (!loading && !failed && online)) return null
  return createPortal(
    <div className="font-loading-feedback" role="status" aria-live="polite">
      {!online
        ? 'Offline. Downloaded fonts remain available; other fonts use system fallbacks.'
        : failed
          ? 'Some fonts couldn’t load. System fallbacks are available.'
          : 'Loading fonts… You can keep editing.'}
      {failed && (
        <button type="button" onClick={() => void retryFailedFonts()}>
          Retry fonts
        </button>
      )}
    </div>,
    container,
  )
}
