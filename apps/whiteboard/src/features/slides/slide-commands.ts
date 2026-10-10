import {
  CaptureUpdateAction,
  newElementWith,
  restoreElements,
  getCommonBounds,
  convertToExcalidrawElements,
} from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { getSlides, orderBetween, slideCustomData, slideMetadata, newSlideData } from './slide-model'

export type SlideCommand =
  | { type: 'move'; id: string; offset: -1 | 1 }
  | { type: 'remove'; id: string }
  | { type: 'place'; id: string; targetId: string; after: boolean }

export function applySlideCommand(elements: readonly ExcalidrawElement[], command: SlideCommand): ExcalidrawElement[] {
  const slides = getSlides(elements)
  const slide = slides.find((entry) => entry.id === command.id)
  if (!slide) return [...elements]
  if (command.type === 'remove')
    return elements.map((element) =>
      element.id === slide.id
        ? newElementWith(element, { isDeleted: true })
        : element.frameId === slide.id
          ? newElementWith(element, { frameId: null })
          : element,
    )
  const from = slides.indexOf(slide),
    to = command.type === 'place' ? slides.findIndex((entry) => entry.id === command.targetId) : from + command.offset
  if (to < 0 || to >= slides.length) return [...elements]
  const sorted = [...slides]
  sorted.splice(from, 1)
  const insertion =
    command.type === 'place' ? sorted.findIndex((entry) => entry.id === command.targetId) + Number(command.after) : to
  if (insertion < 0 || (command.type === 'place' && command.targetId === slide.id)) return [...elements]
  sorted.splice(insertion, 0, slide)
  let key: string
  try {
    key = orderBetween(
      sorted[insertion - 1] && slideMetadata(sorted[insertion - 1])!.orderKey,
      sorted[insertion + 1] && slideMetadata(sorted[insertion + 1])!.orderKey,
    )
    if (key.length > 160) throw new Error('Rebalance')
  } catch {
    const positions = new Map(sorted.map((entry, index) => [entry.id, `${index}/1`]))
    return elements.map((element) =>
      positions.has(element.id)
        ? newElementWith(element, { customData: slideCustomData(element, positions.get(element.id)!) })
        : element,
    )
  }
  return elements.map((element) =>
    element.id === slide.id ? newElementWith(element, { customData: slideCustomData(element, key) }) : element,
  )
}

export function commitSlideCommand(api: ExcalidrawImperativeAPI, command: SlideCommand) {
  api.updateScene({
    elements: applySlideCommand(api.getSceneElementsIncludingDeleted(), command),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  })
}

/** Invoked by native duplication before its scene transaction is committed. */
export function normalizeDuplicatedSlides(next: readonly ExcalidrawElement[], previous: readonly ExcalidrawElement[]) {
  const known = new Set(previous.map((element) => element.id))
  let result = [...next]
  for (const copy of getSlides(next).filter((slide) => !known.has(slide.id))) {
    const slides = getSlides(result)
    const originals = slides.filter(
      (slide) => known.has(slide.id) && slideMetadata(slide)!.orderKey === slideMetadata(copy)!.orderKey,
    )
    const source = originals[0]
    const sourceIndex = source ? slides.indexOf(source) : slides.length - 1
    const after = slides
      .slice(sourceIndex + 1)
      .find((slide) => slide.id !== copy.id && slideMetadata(slide)!.orderKey !== slideMetadata(copy)!.orderKey)
    const key = orderBetween(source && slideMetadata(source)!.orderKey, after && slideMetadata(after)!.orderKey)
    result = result.map((element) =>
      element.id === copy.id ? newElementWith(element, { customData: slideCustomData(element, key) }) : element,
    )
  }
  return result
}

export function duplicateSlide(api: ExcalidrawImperativeAPI, id: string): string | undefined {
  const elements = api.getSceneElementsIncludingDeleted(),
    slides = getSlides(elements)
  const source = slides.find((slide) => slide.id === id)
  if (!source) return
  const index = slides.indexOf(source)
  let key: string
  try {
    key = orderBetween(slideMetadata(source)!.orderKey, slides[index + 1] && slideMetadata(slides[index + 1])!.orderKey)
  } catch {
    // Normalize tied ranks before inserting the copy, within the same undo transaction.
    const ranks = new Map(slides.map((slide, position) => [slide.id, `${position}/1`]))
    const normalized = elements.map((element) =>
      ranks.has(element.id)
        ? newElementWith(element, { customData: slideCustomData(element, ranks.get(element.id)!) })
        : element,
    )
    return duplicateIntoScene(api, normalized, source.id, orderBetween(`${index}/1`, `${index + 1}/1`))
  }
  return duplicateIntoScene(api, elements, source.id, key)
}

function duplicateIntoScene(
  api: ExcalidrawImperativeAPI,
  elements: readonly ExcalidrawElement[],
  id: string,
  key: string,
) {
  const source = elements.find((element) => element.id === id)!
  const content = elements.filter((element) => !element.isDeleted && (element.id === id || element.frameId === id))
  const ids = new Map(content.map((element) => [element.id, crypto.randomUUID()]))
  const groups = new Map<string, string>()
  for (const element of content)
    for (const group of element.groupIds) if (!groups.has(group)) groups.set(group, crypto.randomUUID())
  const copies = content.map((element) => {
    const copy = structuredClone(element) as any
    copy.id = ids.get(element.id)
    copy.x += source.width + 60
    copy.index = null
    copy.version = 1
    copy.versionNonce = Math.floor(Math.random() * 2147483647)
    copy.updated = Date.now()
    copy.groupIds = element.groupIds.map((group) => groups.get(group))
    copy.frameId = element.frameId ? (ids.get(element.frameId) ?? null) : null
    copy.boundElements =
      element.boundElements
        ?.filter((bound) => ids.has(bound.id))
        .map((bound) => ({ ...bound, id: ids.get(bound.id) })) ?? null
    if (copy.containerId) copy.containerId = ids.get(copy.containerId) ?? null
    for (const binding of ['startBinding', 'endBinding']) {
      if (copy[binding])
        copy[binding] = ids.has(copy[binding].elementId)
          ? { ...copy[binding], elementId: ids.get(copy[binding].elementId) }
          : null
    }
    if (element.id === id) copy.customData = slideCustomData(element, key)
    return copy
  })
  api.updateScene({
    elements: restoreElements([...elements, ...copies], null),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  })
  return ids.get(id)!
}

/** Native frame membership and a single undo transaction, shared with MCP creation. */
export function createSlide(
  api: ExcalidrawImperativeAPI,
  options: { elementIds?: string[]; bounds?: { x: number; y: number; width: number; height: number }; padding: number },
) {
  const elements = api.getSceneElements()
  if (Boolean(options.elementIds) === Boolean(options.bounds))
    throw new Error('Provide elementIds or bounds, not both.')
  const ids = new Set(options.elementIds)
  const selected = elements.filter((element) => ids.has(element.id))
  if (options.elementIds && selected.length !== ids.size) throw new Error('One or more elements were not found.')
  if (selected.some((element) => element.frameId || element.type === 'frame' || element.type === 'magicframe'))
    throw new Error('Slide creation requires drawings outside existing frames.')
  const groups = new Set(selected.flatMap((element) => element.groupIds))
  const contents = elements.filter(
    (element) =>
      ids.has(element.id) ||
      element.groupIds.some((group) => groups.has(group)) ||
      (element.type === 'text' && element.containerId && ids.has(element.containerId)),
  )
  if (contents.some((element) => element.frameId)) throw new Error('A selected group belongs to another frame.')
  const [left, top, right, bottom] = contents.length ? getCommonBounds(contents) : [0, 0, 0, 0]
  const bounds = options.bounds ?? {
    x: left - options.padding,
    y: top - options.padding,
    width: Math.max(1, right - left + options.padding * 2),
    height: Math.max(1, bottom - top + options.padding * 2),
  }
  const [frame] = convertToExcalidrawElements([
    { type: 'frame', children: [], ...bounds, customData: newSlideData(elements) },
  ])
  const contained = new Set(
    elements
      .filter((element) => {
        if (element.frameId || element.type === 'frame' || element.type === 'magicframe') return false
        const [x1, y1, x2, y2] = getCommonBounds([element])
        return x1 >= bounds.x && y1 >= bounds.y && x2 <= bounds.x + bounds.width && y2 <= bounds.y + bounds.height
      })
      .map((element) => element.id),
  )
  // Never split a group across a frame boundary.
  for (const element of elements) {
    if (
      contained.has(element.id) &&
      element.groupIds.some((group) =>
        elements.some((other) => other.groupIds.includes(group) && !contained.has(other.id)),
      )
    )
      contained.delete(element.id)
  }
  api.updateScene({
    elements: [
      ...api
        .getSceneElementsIncludingDeleted()
        .map((element) => (contained.has(element.id) ? newElementWith(element, { frameId: frame.id }) : element)),
      frame,
    ],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  })
  return frame.id
}
