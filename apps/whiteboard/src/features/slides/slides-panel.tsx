import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MutableRefObject,
} from 'react'
import { createPortal, flushSync } from 'react-dom'
import {
  Share2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Copy,
  PanelRightClose,
  Presentation,
  Trash2,
  ArrowUp,
  ArrowDown,
} from 'lucide-react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { createSceneSession } from '../scene/scene-session'
import { activeSlideAfterChange, getSlides } from './slide-model'
import { commitSlideCommand, duplicateSlide } from './slide-commands'
import { SlidePreview, SlidePreviewCacheContext } from './slide-preview'
import { createSlidePreviewCache } from './slide-preview-cache'
import { SlideNotes } from './slide-notes'
import { copySlideNotes } from './notes-store'
import { SpeakerView, useSpeakerWindow } from './speaker-view'
import { BoardSidebar } from '../sidebar/board-sidebar'
import type { ReactNode } from 'react'

export function SlidesPanel({
  session,
  containerRef,
  apiRef,
  boardId,
  projectId,
  identity,
  cloud,
  canEdit,
  onInteraction,
  onStageChange,
  onSharePresentation,
}: {
  session: ReturnType<typeof createSceneSession>
  containerRef: MutableRefObject<HTMLElement | null>
  apiRef: MutableRefObject<ExcalidrawImperativeAPI | null>
  boardId: string
  projectId: string
  identity: string
  cloud: boolean
  canEdit: boolean
  onInteraction: () => void
  onStageChange: (open: boolean) => void
  onSharePresentation: () => void
}) {
  const previewCache = useMemo(createSlidePreviewCache, [boardId, identity])
  useEffect(() => () => previewCache.clear(), [previewCache])
  const api = apiRef.current
  const scene = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const slides = useMemo(() => getSlides(scene.elements), [scene.elements])
  const [open, setOpen] = useState(false),
    [activeId, setActiveId] = useState<string | null>(null)
  const [warmPreviews, setWarmPreviews] = useState(false)
  const [notes, setNotes] = useState(false),
    [stage, setStage] = useState(false),
    [presentationMenu, setPresentationMenu] = useState(false),
    [message, setMessage] = useState('')
  useEffect(() => {
    setWarmPreviews(false)
    if (!open || stage) return
    const timer = window.setTimeout(() => setWarmPreviews(true), 1000)
    return () => window.clearTimeout(timer)
  }, [open, stage])
  const speaker = useSpeakerWindow()
  const previous = useRef(slides),
    panelRef = useRef<HTMLElement>(null),
    scrollPosition = useRef(0),
    stageRef = useRef<HTMLDivElement>(null),
    enteredFullscreen = useRef(false),
    opener = useRef<HTMLElement | null>(null)
  const active = slides.find((slide) => slide.id === activeId) ?? slides[0]
  const position = active ? slides.indexOf(active) : -1
  useEffect(() => {
    const prior = previous.current
    setActiveId((id) => activeSlideAfterChange(prior, slides, id))
    previous.current = slides
  }, [slides])
  useEffect(() => {
    if (!slides.length || !canEdit) {
      setNotes(false)
      speaker.close()
    }
    if (!slides.length && stage) closeStage()
  }, [slides.length, canEdit, stage])
  useEffect(() => () => onStageChange(false), [onStageChange])
  function go(index: number, moveCamera = true, focusStage = true) {
    const slide = slides[index]
    if (!slide) return
    setActiveId(slide.id)
    if (!moveCamera && focusStage) stageRef.current?.focus()
    if (moveCamera && api) {
      onInteraction()
      const state = api.getAppState()
      const panel = panelRef.current?.getBoundingClientRect()
      // Fit in the canvas left of the native sidebar; the rail has its own layout space.
      const right = panel ? Math.max(0, state.offsetLeft + state.width - panel.left) : 0
      api.scrollToContent(slide, {
        fitToViewport: true,
        viewportZoomFactor: 0.8,
        canvasOffsets: { right },
        animate: true,
        duration: 250,
      })
    }
  }
  function closeStage() {
    speaker.close()
    enteredFullscreen.current = false
    if (document.fullscreenElement === stageRef.current) void document.exitFullscreen().catch(() => {})
    setStage(false)
    onStageChange(false)
    opener.current?.focus()
  }
  function openStage(presenter = false) {
    opener.current = containerRef.current?.querySelector<HTMLElement>('.slides-present') ?? null
    enteredFullscreen.current = false
    flushSync(() => {
      setPresentationMenu(false)
      setMessage('')
      setStage(true)
      onStageChange(true)
    })
    stageRef.current?.focus()
    if (presenter) {
      const source = containerRef.current?.querySelector<HTMLElement>('.excalidraw')
      if (!source || !speaker.open(source)) {
        closeStage()
        setMessage('Allow popups to open presenter view, then try again.')
      }
    } else {
      const fullscreenRequest = stageRef.current?.requestFullscreen?.() ?? Promise.reject(new Error('Unavailable'))
      void fullscreenRequest
        .then(() => {
          if (stageRef.current) enteredFullscreen.current = true
        })
        .catch(() => setMessage('Fullscreen unavailable · showing a windowed presentation'))
    }
  }
  useEffect(() => {
    if (!stage) return
    const fullscreenChange = () => {
      if (stageRef.current && document.fullscreenElement === stageRef.current) enteredFullscreen.current = true
      else if (enteredFullscreen.current) closeStage()
    }
    document.addEventListener('fullscreenchange', fullscreenChange)
    return () => document.removeEventListener('fullscreenchange', fullscreenChange)
  }, [stage])

  async function duplicate() {
    if (!api || !active || !canEdit) return
    onInteraction()
    const copiedId = duplicateSlide(api, active.id)
    if (!copiedId) return
    try {
      await copySlideNotes({ identity, boardId, projectId, cloud }, active.id, copiedId)
    } catch {
      setMessage('Slide copied · speaker notes could not sync. Reopen its notes to retry.')
    } finally {
      setActiveId(copiedId)
    }
  }

  const container = containerRef.current?.querySelector<HTMLElement>('.excalidraw')
  if (!container) return null

  return (
    <SlidePreviewCacheContext.Provider value={previewCache}>
      <BoardSidebar
        api={api}
        containerRef={containerRef}
        slideCount={slides.length}
        theme={scene.theme}
        onSlidesVisibilityChange={setOpen}
        slidesHeader={
          <>
            <div className="slides-present-split">
              <button
                className="slides-present sidebar-trigger"
                aria-label="Present slides"
                title="Start fullscreen slideshow"
                onClick={() => openStage()}
              >
                Slideshow
              </button>
              <DropdownMenu.Root open={presentationMenu} onOpenChange={setPresentationMenu}>
                <DropdownMenu.Trigger asChild>
                  <button className="slides-present-options sidebar-trigger" aria-label="Presentation options">
                    <ChevronDown size={14} />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal container={container}>
                  <DropdownMenu.Content
                    className="slides-presentation-menu"
                    data-prevent-outside-click
                    align="end"
                    sideOffset={6}
                    onCloseAutoFocus={(event) => {
                      if (stageRef.current) event.preventDefault()
                    }}
                  >
                    <DropdownMenu.Item onSelect={() => openStage()}>
                      <Presentation size={17} /> Slideshow
                    </DropdownMenu.Item>
                    {canEdit && (
                      <DropdownMenu.Item onSelect={() => openStage(true)}>
                        <PanelRightClose size={17} /> Presenter view
                      </DropdownMenu.Item>
                    )}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
            {canEdit && (
              <button
                className="sidebar-trigger slides-share-presentation"
                aria-label="Share board"
                title="Share board"
                onClick={onSharePresentation}
              >
                <Share2 size={18} />
              </button>
            )}
          </>
        }
      >
        <SlidesTab panelRef={panelRef} scrollPosition={scrollPosition}>
          {!slides.length ? (
            <p className="slides-empty">
              Choose <strong>Components → Slide</strong> in the toolbar, then draw around your content.
            </p>
          ) : (
            <>
              <div
                className="slide-navigation"
                onKeyDown={(event) => {
                  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                    event.preventDefault()
                    event.stopPropagation()
                    go(position + (event.key === 'ArrowLeft' ? -1 : 1))
                  }
                }}
              >
                <button aria-label="Previous slide" disabled={position <= 0} onClick={() => go(position - 1)}>
                  <ChevronLeft size={18} />
                </button>
                <span>
                  {position + 1} / {slides.length}
                </span>
                <button
                  aria-label="Next slide"
                  disabled={position >= slides.length - 1}
                  onClick={() => go(position + 1)}
                >
                  <ChevronRight size={18} />
                </button>
              </div>
              <div className="slides-list">
                {slides.map((slide, index) => (
                  <button
                    key={slide.id}
                    className={`slide-card ${slide.id === active?.id ? 'selected' : ''}`}
                    onClick={() => go(index)}
                    aria-label={`Go to slide ${index + 1}`}
                    aria-current={slide.id === active?.id ? 'true' : undefined}
                  >
                    <SlidePreview slide={slide} scene={scene} preload={warmPreviews && !stage} />
                    <span>Slide {index + 1}</span>
                  </button>
                ))}
              </div>
              {active && canEdit && (
                <div className="slide-properties">
                  <div className="slide-actions">
                    <button
                      aria-label="Move slide earlier"
                      disabled={position === 0}
                      onClick={() => {
                        onInteraction()
                        if (api) commitSlideCommand(api, { type: 'move', id: active.id, offset: -1 })
                      }}
                    >
                      <ArrowUp size={16} />
                    </button>
                    <button
                      aria-label="Move slide later"
                      disabled={position === slides.length - 1}
                      onClick={() => {
                        onInteraction()
                        if (api) commitSlideCommand(api, { type: 'move', id: active.id, offset: 1 })
                      }}
                    >
                      <ArrowDown size={16} />
                    </button>
                    <button aria-label="Duplicate slide" onClick={() => void duplicate()}>
                      <Copy size={16} />
                    </button>
                    <button
                      aria-label="Remove slide boundary, keep drawings"
                      onClick={() => {
                        onInteraction()
                        if (api) commitSlideCommand(api, { type: 'remove', id: active.id })
                      }}
                    >
                      <Trash2 size={16} />
                    </button>
                    <button onClick={() => setNotes(!notes)} aria-expanded={notes}>
                      Notes
                    </button>
                  </div>
                  {notes && !stage && (
                    <SlideNotes
                      key={`${identity}:${active.id}`}
                      boardId={boardId}
                      projectId={projectId}
                      slideId={active.id}
                      identity={identity}
                      cloud={cloud}
                    />
                  )}
                </div>
              )}
            </>
          )}
          {message && (
            <p role="status" className="slides-message">
              {message}
            </p>
          )}
        </SlidesTab>
      </BoardSidebar>
      {createPortal(
        <>
          {stage && active && canEdit && speaker.host && (
            <SpeakerView
              host={speaker.host}
              slides={slides}
              active={active}
              scene={scene}
              onGo={(index) => go(index, false, false)}
              onEnd={closeStage}
              boardId={boardId}
              projectId={projectId}
              identity={identity}
              cloud={cloud}
            />
          )}
          {stage && active && (
            <div
              ref={stageRef}
              className="fullscreen-slides"
              tabIndex={-1}
              role="dialog"
              aria-modal="true"
              aria-label="Slideshow"
              data-slide-number={position + 1}
              onKeyDown={(event) => {
                event.stopPropagation()
                if (event.key === 'Escape') {
                  event.preventDefault()
                  closeStage()
                }
                if (['ArrowRight', 'PageDown', ' '].includes(event.key)) {
                  event.preventDefault()
                  go(position + 1, false)
                }
                if (['ArrowLeft', 'PageUp'].includes(event.key)) {
                  event.preventDefault()
                  go(position - 1, false)
                }
                if (event.key === 'Home') {
                  event.preventDefault()
                  go(0, false)
                }
                if (event.key === 'End') {
                  event.preventDefault()
                  go(slides.length - 1, false)
                }
                if (event.key === 'Tab') {
                  event.preventDefault()
                }
              }}
            >
              <div className="presentation-body">
                <div className="fullscreen-slide-content">
                  <SlidePreview key={active.id} slide={active} scene={scene} large />
                </div>
              </div>
              {message && (
                <p role="status" className="presentation-message">
                  {message}
                </p>
              )}
            </div>
          )}
        </>,
        container,
      )}
    </SlidePreviewCacheContext.Provider>
  )
}

function SlidesTab({
  children,
  panelRef,
  scrollPosition,
}: {
  children: ReactNode
  panelRef: MutableRefObject<HTMLElement | null>
  scrollPosition: MutableRefObject<number>
}) {
  useLayoutEffect(() => {
    const list = panelRef.current?.querySelector<HTMLElement>('.slides-list')
    if (!list) return
    const previous = scrollPosition.current
    list.scrollTop = previous
    const restore = requestAnimationFrame(() => {
      list.scrollTop = previous
    })
    return () => cancelAnimationFrame(restore)
  }, [panelRef, scrollPosition])
  return (
    <aside
      ref={panelRef}
      id="slides-panel"
      className="slides-panel"
      aria-label="Slides"
      onScrollCapture={(event) => {
        const target = event.target as HTMLElement
        if (target.classList.contains('slides-list')) scrollPosition.current = target.scrollTop
      }}
    >
      {children}
    </aside>
  )
}
