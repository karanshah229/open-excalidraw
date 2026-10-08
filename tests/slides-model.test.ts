import assert from 'node:assert/strict'
import {
  activeSlideAfterChange,
  compareOrder,
  getSlides,
  newSlideData,
  orderBetween,
  slideCustomData,
  slideLabel,
} from '../apps/whiteboard/src/features/slides/slide-model'
import { createSlidePreviewCache } from '../apps/whiteboard/src/features/slides/slide-preview-cache'
import { createSceneSession } from '../apps/whiteboard/src/features/scene/scene-session'
import {
  reconcileElementsLWW,
  mergeDeltaRecordsOntoBase,
} from '../apps/whiteboard/src/features/collaboration/reconcile'

const frame = (id: string, key?: string): any => ({
  id,
  type: 'frame',
  name: null,
  x: 0,
  y: 0,
  width: 400,
  height: 300,
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  frameId: null,
  customData: { existing: 'preserved', ...(key ? slideCustomData({}, key) : {}) },
})
const a = frame('a', '0/1'),
  b = frame('b', '1/1'),
  c = frame('c', '2/1')
assert.deepEqual(
  getSlides([c, frame('ordinary'), b, a]).map((entry) => entry.id),
  ['a', 'b', 'c'],
)
assert.equal(slideLabel(b, [c, b, a]), 'Slide 2')
assert.equal(slideLabel({ ...b, name: 'Legacy title' }, [c, b, a]), 'Slide 2')
assert.equal(slideLabel(frame('ordinary'), [a]), undefined)
assert.equal(compareOrder('1/3', '2/6'), 0)
let after = '1/1'
for (let i = 0; i < 500; i++) {
  const key = orderBetween('0/1', after)
  assert(compareOrder(key, after) < 0)
  assert(compareOrder(key, '0/1') > 0)
  after = key
}
assert.deepEqual(
  getSlides([frame('z', '1/2'), frame('x', '2/4')]).map((entry) => entry.id),
  ['x', 'z'],
)
assert.equal(newSlideData([a, b]).agenticWhiteboard.slide.orderKey, '2/1')
assert.equal(getSlides([frame('bad', 'not-a-rank'), { ...a, width: NaN }, { ...b, isDeleted: true }]).length, 0)
const moved = [a, { ...b, version: 2, customData: slideCustomData(b, '-1/1') }, c]
assert.equal(activeSlideAfterChange([a, b, c], [a, c], 'b'), 'c')
assert.equal(activeSlideAfterChange([a, b, c], [a, b], 'c'), 'b')
assert.equal(activeSlideAfterChange([a], [], 'a'), null)
const replicated = reconcileElementsLWW([a, b, c], moved)
assert.deepEqual(
  getSlides(replicated).map((entry) => entry.id),
  ['b', 'a', 'c'],
)
const compacted = mergeDeltaRecordsOntoBase([a, b, c], [{ id: 'b', data: JSON.stringify(moved[1]) }])
assert.deepEqual(
  getSlides(compacted as any).map((entry) => entry.id),
  ['b', 'a', 'c'],
)
const session = createSceneSession()
let count = 0
const stop = session.subscribe(() => count++)
session.publish([a], { viewBackgroundColor: '#fff' }, {})
session.publish([a], { viewBackgroundColor: '#fff' }, {})
assert.equal(count, 1)
session.publish(moved, { viewBackgroundColor: '#fff' }, {})
assert.equal(count, 2)
const mutable = [a]
session.publish(mutable, { viewBackgroundColor: '#fff' }, {})
const observed = session.getSnapshot().elements
mutable.push(b)
session.publish(mutable, { viewBackgroundColor: '#fff' }, {})
assert.notEqual(session.getSnapshot().elements, observed, 'Engine array reuse must publish a new React dependency')
assert.equal(observed.length, 1)
session.publish(mutable, { viewBackgroundColor: '#fff', theme: 'dark' }, {})
assert.equal(session.getSnapshot().theme, 'dark', 'Presentation rendering follows the board theme')
const finalCount = count
stop()
session.publish([], { viewBackgroundColor: '#fff' }, {})
assert.equal(count, finalCount)
console.log('Slide model, rational ordering, command, replication, compaction and subscription checks passed')

const previews = createSlidePreviewCache(6)
const firstPreview = new Blob(['old'])
previews.put('slide:360', 'version-1', firstPreview)
assert.equal(previews.get('slide:360', 'version-1'), firstPreview)
assert.equal(previews.get('slide:360', 'version-2'), undefined)
assert.equal(
  previews.peek('slide:360')?.blob,
  firstPreview,
  'Retain the previous bytes while its replacement is pending',
)
const newPreview = new Blob(['new'])
previews.put('slide:360', 'version-2', newPreview)
assert.equal(previews.get('slide:360', 'version-1'), undefined)
assert.equal(previews.get('slide:360', 'version-2'), newPreview)
previews.put('other:360', 'version-1', firstPreview)
previews.get('slide:360', 'version-2')
previews.put('third:360', 'version-1', firstPreview)
assert.equal(previews.peek('other:360'), undefined, 'Evict the least recently used entry to bound bytes')
assert.equal(previews.peek('slide:360')?.blob, newPreview)
assert.equal(createSlidePreviewCache().peek('slide:360'), undefined, 'Boards never share cached images')
previews.clear()
assert.equal(previews.peek('slide:360'), undefined)
console.log('Slide preview cache reuse, replacement, memory limits and isolation checks passed')
