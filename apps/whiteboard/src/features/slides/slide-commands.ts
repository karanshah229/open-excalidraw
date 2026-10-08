import { CaptureUpdateAction, newElementWith, restoreElements } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { getSlides, orderBetween, slideCustomData, slideMetadata } from './slide-model'

export type SlideCommand = { type: 'move'; id: string; offset: -1 | 1 } | { type: 'remove'; id: string }

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
    to = from + command.offset
  if (to < 0 || to >= slides.length) return [...elements]
  const sorted = [...slides]
  sorted.splice(from, 1)
  sorted.splice(to, 0, slide)
  let key: string
  try {
    key = orderBetween(
      sorted[to - 1] && slideMetadata(sorted[to - 1])!.orderKey,
      sorted[to + 1] && slideMetadata(sorted[to + 1])!.orderKey,
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
