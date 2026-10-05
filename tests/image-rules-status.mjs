// Read deployed rule sources using the existing Firebase CLI account.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
const cliLib = path.resolve(
  path.dirname(fs.realpathSync(execFileSync('which', ['firebase'], { encoding: 'utf8' }).trim())),
  '..',
)
const auth = await import(pathToFileURL(path.join(cliLib, 'auth.js')).href)
const { requireAuth } = await import(pathToFileURL(path.join(cliLib, 'requireAuth.js')).href)
const rulesApi = await import(pathToFileURL(path.join(cliLib, 'gcp/rules.js')).href)
;(async () => {
  const report = {}
  for (const project of ['open-excalidraw-dev-2', 'open-excalidraw-b2ab4']) {
    try {
      await requireAuth({ ...auth.getGlobalDefaultAccount(), project, nonInteractive: true })
      const releases = await rulesApi.listAllReleases(project)
      const rules = []
      for (const release of releases) {
        const service = release.name.split('/releases/')[1]
        if (!service.startsWith('firebase.storage') && service !== 'cloud.firestore') continue
        const files = await rulesApi.getRulesetContent(release.rulesetName)
        const local = fs.readFileSync(
          service.startsWith('firebase.storage') ? 'storage.rules' : 'firestore.rules',
          'utf8',
        )
        const normalize = (text) => text.replace(/\s+/g, '')
        rules.push({
          release: service,
          updated_at: release.updateTime,
          matches_local: files.some((file) => normalize(file.content) === normalize(local)),
        })
      }
      report[project] = { rules }
    } catch (error) {
      report[project] = { error: error.message }
    }
  }
  process.stdout.write(JSON.stringify(report))
})()
