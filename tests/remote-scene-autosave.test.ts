import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { getSceneSignature } from '../apps/whiteboard/src/features/scenes/scene-signature.js'

const require = createRequire(new URL('../apps/whiteboard/package.json', import.meta.url))
const ts = require('typescript')
const editorText = readFileSync(new URL('../apps/whiteboard/src/routes/board-editor.tsx', import.meta.url), 'utf8')
const source = ts.createSourceFile('board-editor.tsx', editorText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

// Execute the production callbacks without mounting the entire authenticated editor.
function callback(name: string, environment: Record<string, any>, optional = false): (...args: any[]) => void {
  let expression: any
  function visit(node: any) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
      expression = node.initializer.arguments[0]
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!expression && optional) return () => {}
  assert.ok(expression, `Production callback ${name} exists`)
  const compiled = ts.transpileModule(`const callback = ${expression.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  return new Function(...Object.keys(environment), `${compiled}\nreturn callback;`)(...Object.values(environment))
}

const appState = { theme: 'light', viewBackgroundColor: '#fff', selectedElementIds: {} }
const original = { id: 'shape', version: 9, versionNonce: 500, x: 10, y: 20, isDeleted: false }
const refs = {
  elementsRef: { current: [original] },
  filesRef: { current: {} },
  appStateRef: { current: appState },
  savedSignature: { current: getSceneSignature({ elements: [original], appState, files: {} }) },
  committedSignatureRef: { current: getSceneSignature({ elements: [original], appState, files: {} }) },
  applyingRemoteSceneRef: { current: false },
  pendingSceneRef: { current: null as any },
  saveTimer: { current: undefined as any },
  awaitingInitialSceneRef: { current: false },
  hasAutoZoomedRef: { current: true },
  userHasInteractedRef: { current: true },
  restoreGateRef: { current: false },
  operationRef: { current: null },
}
const captures: any[] = []
let broadcasts = 0
let publishes = 0
const environment = {
  ...refs,
  getSceneSignature,
  isReadOnly: false,
  isTransitioningCollab: false,
  apiRef: { current: { getFiles: () => ({}), getAppState: () => appState } },
  sceneSession: { publish: () => publishes++ },
  slideMetadata: () => false,
  triggerAutoCenter: () => {},
  broadcastChanges: () => broadcasts++,
  sendScene: () => {},
  scheduleSave: (scene: any) => {
    captures.push(scene)
    refs.pendingSceneRef.current = scene
  },
}
const onChange = callback('onChange', environment)
const onRemoteSceneApply = callback('onRemoteSceneApply', environment, true)
const collaborationText = readFileSync(
  new URL('../apps/whiteboard/src/features/collaboration/use-collaboration.ts', import.meta.url),
  'utf8',
)
const collaborationSource = ts.createSourceFile('use-collaboration.ts', collaborationText, ts.ScriptTarget.Latest, true)
let remoteExpression: any
function findSubscription(node: any) {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'subscribeToElements'
  )
    remoteExpression = node.arguments[1]
  ts.forEachChild(node, findSubscription)
}
findSubscription(collaborationSource)
assert.ok(remoteExpression, 'Production RTDB subscription exists')
const remoteEnvironment = {
  ...environment,
  onRemoteSceneApply,
  restorationBlockedRef: { current: false },
  knownElementVersionsRef: { current: new Map() },
  lastBroadcastElementsRef: { current: new Map() },
  collabUserRef: { current: { uid: 'guest' } },
  isSpectatorRef: { current: false },
  boardId: 'board',
  getFullSceneElements: () => refs.elementsRef.current,
  isValidExcalidrawElement: () => true,
  applyDeltaPatch: (existing: any, patch: any) => ({ ...existing, ...patch }),
  reconcileElements: (_local: any[], incoming: any[]) => incoming,
  service: { broadcastElementDeltas: () => broadcasts++ },
  apiRef: {
    current: {
      ...environment.apiRef.current,
      getSceneElementsIncludingDeleted: () => refs.elementsRef.current,
      updateScene: ({ elements, captureUpdate }: any) => {
        assert.equal(captureUpdate, 'NEVER', 'Remote application preserves the undo boundary')
        // Excalidraw can normalize incoming remote elements (including its
        // version/index metadata) while applying updateScene. This is still a
        // remote render, never a local edit or a new history capture.
        const normalized = elements.map((element: any) => ({
          ...element,
          version: element.version + 1,
          versionNonce: element.versionNonce + 1,
          updated: (element.updated ?? 0) + 1,
          index: 'aP',
        }))
        refs.elementsRef.current = normalized
        onChange(normalized, appState, {})
      },
    },
  },
}
const remoteCompiled = ts.transpileModule(`const callback = ${remoteExpression.getText(collaborationSource)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText
const receiveRemote = new Function(...Object.keys(remoteEnvironment), `${remoteCompiled}\nreturn callback;`)(
  ...Object.values(remoteEnvironment),
)
function remote(element: typeof original) {
  receiveRemote(element, { lastModifiedBy: 'peer' })
}

remote({ ...original, version: 10, x: 40 })
assert.equal(captures.length, 0, 'A remote geometry update must not create a local capture after prior interaction')
assert.equal(broadcasts, 0, 'Remote updates must not be echoed through local broadcast')
assert.equal(publishes, 1, 'Remote updates still reach derived slide rendering')
assert.equal(
  refs.savedSignature.current,
  getSceneSignature({ elements: refs.elementsRef.current, appState, files: {} }),
  'The dirty baseline uses Excalidraw’s normalized post-update scene',
)
onChange(refs.elementsRef.current, appState, {})
assert.equal(captures.length, 0, 'A later onChange of the normalized remote scene remains an absorbed remote state')

remote({ ...original, version: 10, versionNonce: 100, x: 40 })
assert.equal(captures.length, 0, 'A same-version lower-nonce winner must not create a guest capture')
assert.equal(
  refs.committedSignatureRef.current,
  getSceneSignature({ elements: [original], appState, files: {} }),
  'Remote absorption does not acknowledge pending local persistence',
)

const local = { ...original, version: 11, versionNonce: 200, x: 40, y: 90 }
onChange([local], appState, {})
assert.equal(captures.length, 1, 'A genuine subsequent local edit still schedules its capture')
const pending = refs.pendingSceneRef.current
refs.saveTimer.current = 123
remote({ ...local, version: 12, versionNonce: 300, x: 80 })
assert.equal(captures.length, 1, 'A remote update during local debounce creates no additional capture')
assert.equal(refs.pendingSceneRef.current, pending, 'The original pending local snapshot survives remote application')
assert.equal(refs.saveTimer.current, 123, 'The original debounce timer remains armed')

// Application preferences changed locally are not absorbed by an unrelated old remote signature.
onChange(refs.elementsRef.current, { ...appState, viewBackgroundColor: '#000' }, {})
assert.equal(captures.length, 2, 'A local persisted app-state edit still saves')
console.log('Remote scene autosave regression: geometry, nonce, rendering, local edits, and pending debounce PASS')
