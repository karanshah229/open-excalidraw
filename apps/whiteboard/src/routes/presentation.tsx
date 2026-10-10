import { usePresentationDataBridge } from '../features/mcp-bridge/presentation-data-bridge'
import { useAppChrome } from '../lib/app-chrome-context'
import { getFirebaseAuth } from '../lib/firebase'
import { ensureAuthenticatedUser } from '../features/collaboration/anonymous-user'
import { useEffect, useLayoutEffect, useState, useRef } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { useSpeakerWindow } from '../features/slides/speaker-view'
import { useParams } from '@tanstack/react-router'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Maximize,
  X,
  Presentation,
  PanelRightClose,
  Pause,
  Play,
  RotateCcw,
  AArrowDown,
  AArrowUp,
} from 'lucide-react'
import { sharingService, type BoardShareConfig } from '../features/sharing/sharing-service'
import { useAuth } from '../lib/auth-context'
import { getSlides } from '../features/slides/slide-model'
import { renderSlide, slideRenderKey } from '../features/slides/slide-renderer'
import { callNote } from '../features/slides/notes-store'
import type { SceneSnapshot } from '../features/scene/scene-session'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useTheme } from '../lib/theme-context'

type RenderedPage = { image: string; key: string }
type PresentationManifest = { title: string; count: number }

export function PresentationPage() {
  const { boardId } = useParams({ from: '/presentations/$boardId' })
  return <PresentationView boardId={boardId} />
}

export function PresentationView({ boardId, config: providedConfig }: { boardId: string; config?: BoardShareConfig }) {
  const { user } = useAuth()
  const { setPresentationActive } = useAppChrome()
  useLayoutEffect(() => {
    setPresentationActive(true)
    return () => setPresentationActive(false)
  }, [setPresentationActive])
  const { resolvedTheme: appTheme } = useTheme()
  const [presenterMode, setPresenterMode] = useState(false)
  const [manifest, setManifest] = useState<PresentationManifest | null>(null)
  const [index, setIndex] = useState(0)
  const [displayed, setDisplayed] = useState<{ index: number; page: RenderedPage } | null>(null)
  const [pages, setPages] = useState<Record<number, RenderedPage>>({})
  const cache = useRef(new Map<string, Promise<Blob>>())
  const [config, setConfig] = useState<BoardShareConfig | undefined>(providedConfig)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [notesRevision, setNotesRevision] = useState(0)
  useEffect(() => {
    const updated = (event: Event) => {
      if ((event as CustomEvent).detail?.boardId === boardId) setNotesRevision((value) => value + 1)
    }
    window.addEventListener('slide-notes-updated', updated)
    return () => window.removeEventListener('slide-notes-updated', updated)
  }, [boardId])
  const urls = useRef(new Set<string>())
  const [error, setError] = useState('')
  const speaker = useSpeakerWindow()
  const [started, setStarted] = useState(false)
  const [fullscreenError, setFullscreenError] = useState('')
  const [fullscreen, setFullscreen] = useState(false)
  const [notesSize, setNotesSize] = useState(20)
  const [seconds, setSeconds] = useState(0)
  const [paused, setPaused] = useState(false)
  const stage = useRef<HTMLDivElement>(null)
  useEffect(() => {
    setDisplayed(null)
    setPages({})
    setNotes({})
    setIndex(0)
    setStarted(false)
    speaker.close()
  }, [boardId])
  useEffect(() => {
    if (providedConfig) {
      setConfig(providedConfig)
      setError('')
      return
    }
    setConfig(undefined)
    setError('')
    return sharingService.subscribeToSharedBoard(boardId, setConfig, () => {
      speaker.close()
      setStarted(false)
      setPages({})
      setConfig(undefined)
      setDisplayed(null)
      setNotes({})
      setError('This presentation is unavailable or access has been removed.')
    })
  }, [boardId, providedConfig, user?.uid])
  const scene: SceneSnapshot | undefined = config?.scene
    ? {
        elements: config.scene.elements as unknown as SceneSnapshot['elements'],
        files: (config.scene.files ?? {}) as SceneSnapshot['files'],
        background: String(config.scene.appState.viewBackgroundColor ?? '#ffffff'),
        theme:
          config.scene.appState.theme === 'dark'
            ? 'dark'
            : config.scene.appState.theme === 'light'
              ? 'light'
              : appTheme,
      }
    : undefined
  const background = scene?.background ?? '#ffffff'
  const hex = background.replace('#', '')
  const rgb =
    hex.length === 3
      ? hex
          .split('')
          .map((part) => part + part)
          .join('')
      : hex
  const brightness = /^[\da-f]{6}$/i.test(rgb)
    ? (parseInt(rgb.slice(0, 2), 16) * 299 +
        parseInt(rgb.slice(2, 4), 16) * 587 +
        parseInt(rgb.slice(4, 6), 16) * 114) /
      1000
    : 255
  const resolvedTheme = brightness < 128 ? 'dark' : (scene?.theme ?? appTheme)
  usePresentationDataBridge(
    config && scene
      ? {
          boardId,
          projectId: config.projectId ?? '',
          identity: user?.uid ?? 'local-user',
          role: config.effectiveRole ?? (config.ownerId === user?.uid ? 'owner' : null),
          local: false,
          scene,
          config,
        }
      : null,
  )
  const slides = scene ? getSlides(scene.elements) : []
  useEffect(() => {
    setManifest(config ? { title: config.boardName, count: slides.length } : null)
    if (config && !slides.length) setError('This board has no slides yet.')
    setIndex((value) => Math.min(value, Math.max(0, slides.length - 1)))
  }, [config])
  useEffect(() => {
    return () => {
      for (const url of urls.current) URL.revokeObjectURL(url)
      urls.current.clear()
      cache.current.clear()
    }
  }, [boardId])
  useEffect(() => {
    const visible = new Set([
      ...Object.values(pages).map((page) => page.image),
      ...(displayed ? [displayed.page.image] : []),
    ])
    for (const url of urls.current)
      if (!visible.has(url)) {
        URL.revokeObjectURL(url)
        urls.current.delete(url)
      }
  }, [pages, displayed])
  useEffect(() => {
    if (!scene || !slides.length) return
    let current = true
    const activeIndex = Math.min(index, slides.length - 1)
    const indices =
      slides.length <= 10
        ? [activeIndex, ...slides.map((_, i) => i).filter((i) => i !== activeIndex)]
        : [activeIndex, activeIndex - 1, activeIndex + 1].filter((i) => i >= 0 && i < slides.length)
    const keep = new Set(indices.map((i) => slideRenderKey(slides[i], scene)))
    for (const key of cache.current.keys()) if (!keep.has(key)) cache.current.delete(key)
    void (async () => {
      for (const i of indices) {
        if (!current) return
        const key = slideRenderKey(slides[i], scene)
        try {
          if (!cache.current.has(key)) cache.current.set(key, renderSlide(slides[i], scene, 1920))
          const blob = await cache.current.get(key)!
          if (!current) return
          const page = { image: URL.createObjectURL(blob), key }
          urls.current.add(page.image)
          setPages((previous) => ({
            ...Object.fromEntries(Object.entries(previous).filter(([n]) => indices.includes(Number(n)))),
            [i]: page,
          }))
          if (i === activeIndex) {
            setDisplayed({ index: i, page })
            setError('')
          }
        } catch {
          cache.current.delete(key)
          if (current && i === activeIndex) setError('This slide could not be rendered.')
        }
      }
    })()
    return () => {
      current = false
    }
  }, [config, index, appTheme])
  const slideId = slides[index]?.id
  useEffect(() => {
    if (!started || !presenterMode || !slideId || !config?.projectId) return
    let current = true
    const auth = getFirebaseAuth()
    const read = async () => {
      if (auth && !auth.currentUser) await ensureAuthenticatedUser(auth)
      return callNote('read', boardId, config.projectId!, slideId)
    }
    read()
      .then((note) => {
        if (current) setNotes((previous) => ({ ...previous, [slideId]: note.text }))
      })
      .catch(() => {
        if (current) setNotes((previous) => ({ ...previous, [slideId]: '' }))
      })
    return () => {
      current = false
    }
  }, [
    started,
    presenterMode,
    notesRevision,
    slideId,
    boardId,
    config?.accessRevision,
    config?.projectPolicy?.accessRevision,
    user?.uid,
  ])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('textarea, input, button')) return
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? (manifest?.count ?? 1) - 1
            : ['ArrowRight', 'PageDown', ' '].includes(event.key)
              ? index + 1
              : ['ArrowLeft', 'PageUp'].includes(event.key)
                ? index - 1
                : null
      if (next !== null) {
        event.preventDefault()
        setIndex(Math.max(0, Math.min((manifest?.count ?? 1) - 1, next)))
      }
    }
    window.addEventListener('keydown', key)
    speaker.host?.window.document.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('keydown', key)
      speaker.host?.window.document.removeEventListener('keydown', key)
    }
  }, [manifest, index, speaker.host])
  useEffect(() => {
    if (paused || !started) return
    const clockStarted = Date.now()
    // Elapsed timestamps keep the timer correct when the tab is in the background.
    let previous = clockStarted
    const clock = window.setInterval(() => {
      const now = Date.now()
      setSeconds((value) => value + (now - previous) / 1000)
      previous = now
    }, 500)
    return () => window.clearInterval(clock)
  }, [paused, started])
  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement === stage.current)
    document.addEventListener('fullscreenchange', changed)
    return () => document.removeEventListener('fullscreenchange', changed)
  }, [])
  useEffect(() => {
    if (speaker.host) speaker.host.window.document.documentElement.dataset.theme = resolvedTheme
    if (started && presenterMode && !speaker.host) {
      setStarted(false)
      if (document.fullscreenElement === stage.current) void document.exitFullscreen().catch(() => {})
    }
  }, [speaker.host, resolvedTheme, started, presenterMode])
  const end = () => {
    speaker.close()
    setStarted(false)
    setFullscreenError('')
    if (document.fullscreenElement === stage.current) void document.exitFullscreen().catch(() => {})
  }
  const go = (next: number) => {
    setIndex(next)
  }
  const enterFullscreen = () => {
    setFullscreenError('')
    void stage.current
      ?.requestFullscreen?.()
      .catch(() => setFullscreenError('Click Fullscreen to expand the slide window.'))
  }
  const start = (withPresenter: boolean) => {
    if (!stage.current) return
    let opened = false
    flushSync(() => {
      opened = !withPresenter || speaker.open(stage.current!)
      if (opened) {
        setPresenterMode(withPresenter)
        setStarted(true)
        setSeconds(0)
        setPaused(false)
      }
    })
    if (opened) enterFullscreen()
    else setFullscreenError('Allow popups to open speaker notes, then try again.')
  }
  const time = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, Math.floor(seconds) % 60]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')
  const presenter = (
    <div
      className={`excalidraw speaker-view shared-presenter${resolvedTheme === 'dark' ? ' theme--dark' : ''}`}
      aria-label="Shared presentation"
    >
      <section className="speaker-view-layout">
        <div className="speaker-view-body">
          <div className="speaker-view-preview">
            {error ? (
              <p role="alert">{error}</p>
            ) : displayed ? (
              <img src={displayed.page.image} alt={`Slide ${displayed.index + 1}`} />
            ) : (
              <p>Loading presentation…</p>
            )}
          </div>
          <div className="speaker-view-controls">
            <button aria-label="End presentation" onClick={end}>
              <X size={18} /> End
            </button>
            <nav aria-label="Presentation controls">
              <button aria-label="Previous slide" disabled={!index} onClick={() => go(index - 1)}>
                <ChevronLeft size={18} />
              </button>
              <span>
                {index + 1} / {manifest?.count ?? '–'}
              </span>
              <button
                aria-label="Next slide"
                disabled={!manifest || index === manifest.count - 1}
                onClick={() => go(index + 1)}
              >
                <ChevronRight size={18} />
              </button>
            </nav>
            <div className="speaker-view-clock">
              <output aria-label="Presentation timer">{time}</output>
              <button aria-label={paused ? 'Resume timer' : 'Pause timer'} onClick={() => setPaused((value) => !value)}>
                {paused ? <Play size={16} /> : <Pause size={16} />}
              </button>
              <button aria-label="Reset timer" onClick={() => setSeconds(0)}>
                <RotateCcw size={16} />
              </button>
            </div>
          </div>
          <div className="speaker-filmstrip" aria-label="Slides">
            {Array.from({ length: manifest?.count ?? 0 }, (_, i) => (
              <button
                key={i}
                aria-label={`Go to slide ${i + 1}`}
                aria-current={i === index ? 'true' : undefined}
                onClick={() => go(i)}
              >
                <span>{i + 1}</span>
                {pages[i] && <img src={pages[i].image} alt={`Slide ${i + 1} thumbnail`} />}
              </button>
            ))}
          </div>
          <aside className="presenter-notes" aria-label="Presenter speaker notes" style={{ fontSize: notesSize }}>
            <div className="slide-notes">
              <label htmlFor="shared-presenter-notes">Speaker notes</label>
              <textarea
                id="shared-presenter-notes"
                readOnly
                value={notes[slideId ?? ''] ?? ''}
                placeholder="No speaker notes for this slide."
              />
            </div>
            <footer className="speaker-notes-footer">
              <span>Speaker notes · View only</span>
              <button
                aria-label="Decrease notes text size"
                disabled={notesSize <= 14}
                onClick={() => setNotesSize((value) => value - 2)}
              >
                <AArrowDown size={18} />
              </button>
              <button
                aria-label="Increase notes text size"
                disabled={notesSize >= 36}
                onClick={() => setNotesSize((value) => value + 2)}
              >
                <AArrowUp size={18} />
              </button>
            </footer>
          </aside>
        </div>
      </section>
    </div>
  )
  return (
    <div
      ref={stage}
      tabIndex={-1}
      className={`excalidraw shared-presentation-host${resolvedTheme === 'dark' ? ' theme--dark' : ''}`}
      aria-label="Shared presentation"
    >
      {started ? (
        <div className="fullscreen-slides shared-presentation">
          <div className="fullscreen-slide-content">
            {error ? (
              <p role="alert">{error}</p>
            ) : displayed ? (
              <img src={displayed.page.image} alt={`Slide ${displayed.index + 1}`} />
            ) : (
              <p>Loading presentation…</p>
            )}
          </div>
          {!presenterMode && (
            <nav aria-label="Presentation controls">
              <button aria-label="Previous slide" disabled={!index} onClick={() => go(index - 1)}>
                <ChevronLeft size={18} />
              </button>
              <span>
                {index + 1} / {manifest?.count ?? '–'}
              </span>
              <button
                aria-label="Next slide"
                disabled={!manifest || index >= manifest.count - 1}
                onClick={() => go(index + 1)}
              >
                <ChevronRight size={18} />
              </button>
              <button aria-label="End presentation" onClick={end}>
                <X size={18} />
              </button>
            </nav>
          )}
          {!fullscreen && (
            <button className="shared-fullscreen-button" aria-label="Fullscreen presentation" onClick={enterFullscreen}>
              <Maximize size={18} /> Fullscreen
            </button>
          )}
        </div>
      ) : (
        <div className="shared-presentation-landing">
          <Presentation size={40} />
          <h1>{manifest?.title ?? 'Presentation'}</h1>
          <p>Present your slides, or open Presenter View for speaker notes and controls.</p>
          <div className="shared-presentation-start">
            <button
              className="shared-slideshow-start"
              disabled={!displayed || Boolean(error)}
              onClick={() => start(false)}
            >
              <Presentation size={18} /> Slideshow
            </button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button aria-label="Presentation options" disabled={!displayed || Boolean(error)}>
                  <ChevronDown size={16} />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal container={stage.current}>
                <DropdownMenu.Content
                  className="slides-presentation-menu"
                  align="end"
                  sideOffset={6}
                  onCloseAutoFocus={(event) => event.preventDefault()}
                >
                  <DropdownMenu.Item onSelect={() => start(false)}>
                    <Presentation size={17} /> Slideshow
                  </DropdownMenu.Item>
                  <DropdownMenu.Item onSelect={() => start(true)}>
                    <PanelRightClose size={17} /> Presenter View
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
          {(error || fullscreenError) && <p role="alert">{error || fullscreenError}</p>}
        </div>
      )}
      {speaker.host && createPortal(presenter, speaker.host.root)}
    </div>
  )
}
