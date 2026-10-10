import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { SceneSnapshot } from '../scene/scene-session'
import { slideLabel, type Slide } from './slide-model'
import { queuedSlideRender, slideRenderKey } from './slide-renderer'
import type { createSlidePreviewCache } from './slide-preview-cache'

export const SlidePreviewCacheContext = createContext<ReturnType<typeof createSlidePreviewCache> | null>(null)

function useBlobUrl(blob: Blob | undefined) {
  const [image, setImage] = useState<{ blob: Blob; url: string }>()
  useLayoutEffect(() => {
    if (!blob) return
    const url = URL.createObjectURL(blob)
    setImage({ blob, url })
    return () => URL.revokeObjectURL(url)
  }, [blob])
  return image?.blob === blob ? image?.url : undefined
}

export function SlidePreview({
  slide,
  scene,
  large = false,
  renderWidth,
  preload = false,
}: {
  slide: Slide
  scene: SceneSnapshot
  large?: boolean
  renderWidth?: number
  preload?: boolean
}) {
  const cache = useContext(SlidePreviewCacheContext)
  const size = renderWidth ?? (large ? 2560 : 360)
  const slot = `${slide.id}:${size}`
  const key = slideRenderKey(slide, scene)
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(large)
  const shouldRender = visible || preload
  const [preview, setPreview] = useState(() => ({ cache, slot, blob: cache?.peek(slot)?.blob }))
  const [error, setError] = useState(false)
  const blob = preview.cache === cache && preview.slot === slot ? preview.blob : cache?.peek(slot)?.blob
  const url = useBlobUrl(blob)
  const latest = useRef({ slide, scene })
  latest.current = { slide, scene }
  useEffect(() => {
    if (large) return
    const observerWindow = ref.current?.ownerDocument.defaultView ?? window
    const observer = new observerWindow.IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      rootMargin: '100px',
    })
    if (ref.current) observer.observe(ref.current)
    return () => observer.disconnect()
  }, [large])
  useEffect(() => {
    const cached = cache?.get(slot, key)
    if (cached) {
      setPreview({ cache, slot, blob: cached })
      setError(false)
      return
    }
    if (!shouldRender) return
    let active = true
    setError(false)
    // Preserve the existing image until a replacement has been generated successfully.
    const timer = window.setTimeout(
      () => {
        const { slide: currentSlide, scene: currentScene } = latest.current
        void queuedSlideRender(currentSlide, currentScene, size, () => active, !visible)
          .then((nextBlob) => {
            if (!active || !nextBlob || slideRenderKey(latest.current.slide, latest.current.scene) !== key) return
            cache?.put(slot, key, nextBlob)
            setPreview({ cache, slot, blob: nextBlob })
          })
          .catch(() => {
            if (active) setError(true)
          })
      },
      large ? 60 : 180,
    )
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [cache, slot, key, visible, large, size, shouldRender])
  return (
    <div
      ref={ref}
      className={large ? 'slide-preview slide-preview-large' : 'slide-preview'}
      style={{ aspectRatio: `${slide.width} / ${slide.height}` }}
    >
      {url ? (
        <img src={url} alt={slideLabel(slide, scene.elements) || 'Slide preview'} draggable={false} />
      ) : (
        <span className="slide-preview-placeholder" role="status">
          {!error && <Loader2 size={18} className="animate-spin" aria-hidden="true" />}
          {error ? 'Preview unavailable' : 'Loading preview…'}
        </span>
      )}
    </div>
  )
}
