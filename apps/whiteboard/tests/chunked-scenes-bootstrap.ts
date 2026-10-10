// Instrument persistence callbacks before React attaches the board's listeners.
// This entry exists only in the isolated chunk browser runner.
import { traceSceneSubscriptions } from './chunked-scene-fixture'
await traceSceneSubscriptions()
await import('../src/main')
