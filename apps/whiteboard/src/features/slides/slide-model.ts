import type { ExcalidrawElement, ExcalidrawFrameElement } from '@excalidraw/excalidraw/element/types'

export type Slide = ExcalidrawFrameElement
export type SlideMetadata = { schemaVersion: 1; orderKey: string }
const KEY = /^(-?\d{1,120})\/([1-9]\d{0,119})$/

function rank(key: string): [bigint, bigint] {
  const match = KEY.exec(key)
  if (!match) throw new Error('Invalid slide order.')
  return [BigInt(match[1]), BigInt(match[2])]
}

export function slideMetadata(element: ExcalidrawElement): SlideMetadata | undefined {
  const value = element.customData?.agenticWhiteboard?.slide
  return element.type === 'frame' &&
    value?.schemaVersion === 1 &&
    typeof value.orderKey === 'string' &&
    KEY.test(value.orderKey)
    ? value
    : undefined
}

export function compareOrder(left: string, right: string): number {
  const [a, b] = rank(left),
    [c, d] = rank(right)
  const difference = a * d - c * b
  return difference < 0n ? -1 : difference > 0n ? 1 : 0
}

export function orderBetween(before?: string, after?: string): string {
  if (!before && !after) return '0/1'
  if (!before) {
    const [a, b] = rank(after!)
    return `${a - b}/${b}`
  }
  if (!after) {
    const [a, b] = rank(before)
    return `${a + b}/${b}`
  }
  const [a, b] = rank(before),
    [c, d] = rank(after)
  if (a * d >= c * b) throw new Error('Slide order needs rebalancing.')
  // The mediant lies strictly between the two rational ranks without precision loss.
  return `${a + c}/${b + d}`
}

export function getSlides(elements: readonly ExcalidrawElement[]): Slide[] {
  return elements
    .filter(
      (element): element is Slide =>
        element.type === 'frame' &&
        !element.isDeleted &&
        !!slideMetadata(element) &&
        [element.x, element.y, element.width, element.height].every(Number.isFinite) &&
        element.width > 0 &&
        element.height > 0,
    )
    .sort(
      (a, b) =>
        compareOrder(slideMetadata(a)!.orderKey, slideMetadata(b)!.orderKey) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
}

export function slideCustomData(element: Pick<ExcalidrawElement, 'customData'>, orderKey: string) {
  return {
    ...element.customData,
    agenticWhiteboard: {
      ...element.customData?.agenticWhiteboard,
      slide: { schemaVersion: 1, orderKey },
    },
  }
}

export function newSlideData(elements: readonly ExcalidrawElement[]) {
  const slides = getSlides(elements)
  return slideCustomData({}, orderBetween(slides.length ? slideMetadata(slides.at(-1)!)!.orderKey : undefined))
}

export function slideLabel(frame: ExcalidrawElement, elements: readonly ExcalidrawElement[]) {
  if (!slideMetadata(frame)) return undefined
  const number = getSlides(elements).findIndex((slide) => slide.id === frame.id) + 1
  return `Slide ${number || '…'}`
}

export function activeSlideAfterChange(previous: readonly Slide[], next: readonly Slide[], id: string | null) {
  if (id && next.some((slide) => slide.id === id)) return id
  if (!next.length) return null
  const oldIndex = previous.findIndex((slide) => slide.id === id)
  for (const slide of previous.slice(oldIndex + 1)) if (next.some((entry) => entry.id === slide.id)) return slide.id
  for (const slide of previous.slice(0, Math.max(0, oldIndex)).reverse()) {
    if (next.some((entry) => entry.id === slide.id)) return slide.id
  }
  return next[0].id
}
