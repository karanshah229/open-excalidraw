import { exportToBlob } from '@excalidraw/excalidraw'
import type { SceneSnapshot } from '../scene/scene-session'
import type { Slide } from './slide-model'

/** One crop policy for previews and audience rendering. Image bytes stay local. */
export async function renderSlide(slide: Slide, scene: SceneSnapshot, size: number) {
  return exportToBlob({
    elements: scene.elements.filter((element) => !element.isDeleted),
    files: scene.files,
    exportingFrame: slide,
    getDimensions: (width: number, height: number) => {
      const scale = Math.min(8, size / Math.max(width, height))
      return { width: Math.round(width * scale), height: Math.round(height * scale), scale }
    },
    appState: {
      viewBackgroundColor: scene.background === 'transparent' ? '#ffffff' : scene.background,
      exportBackground: true,
      exportWithDarkMode: scene.theme === 'dark',
      exportEmbedScene: false,
    },
    mimeType: 'image/png',
  })
}

export function slideRenderKey(slide: Slide, scene: SceneSnapshot) {
  // Only the target frame and possibly visible overlaps affect its crop.
  const relevant = scene.elements.filter((element) => {
    if (element.isDeleted || (element.frameId && element.frameId !== slide.id)) return false
    const cosine = Math.abs(Math.cos(element.angle)),
      sine = Math.abs(Math.sin(element.angle))
    const halfWidth = (element.width * cosine + element.height * sine) / 2 + 20
    const halfHeight = (element.height * cosine + element.width * sine) / 2 + 20
    const x = element.x + element.width / 2,
      y = element.y + element.height / 2
    return (
      x - halfWidth <= slide.x + slide.width &&
      y - halfHeight <= slide.y + slide.height &&
      x + halfWidth >= slide.x &&
      y + halfHeight >= slide.y
    )
  })
  return (
    `${scene.theme}:${scene.background}:${slide.id}:${slide.version}:${slide.versionNonce}:` +
    relevant
      .map(
        (element) =>
          `${element.id}:${element.version}:${element.versionNonce}:` +
          (element.type === 'image' && element.fileId ? !!scene.files[element.fileId]?.dataURL : ''),
      )
      .join('|')
  )
}

// Serial rendering bounds image/canvas pressure even with a large slide list.
type RenderJob = { background: boolean; run: () => Promise<void> }
const queue: RenderJob[] = []
let rendering = false
async function drainQueue() {
  if (rendering) return
  rendering = true
  try {
    while (queue.length) {
      const foreground = queue.findIndex((job) => !job.background)
      const [job] = queue.splice(foreground < 0 ? 0 : foreground, 1)
      await job.run()
    }
  } finally {
    rendering = false
  }
}
export function queuedSlideRender(
  slide: Slide,
  scene: SceneSnapshot,
  size: number,
  current: () => boolean,
  background = false,
) {
  return new Promise<Blob | null>((resolve, reject) => {
    queue.push({
      background,
      run: async () => {
        try {
          resolve(current() ? await renderSlide(slide, scene, size) : null)
        } catch (error) {
          reject(error)
        }
      },
    })
    void drainQueue()
  })
}
