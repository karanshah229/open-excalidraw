/** Isolated real component; unavailable as a production bundle entry point. */
import { createRoot } from 'react-dom/client'
import { AuthProvider } from '../src/lib/auth-context'
import { UserProvider } from '../src/lib/user-context'
import { SyncStatusDropdown, type SyncStatusDropdownProps } from '../src/components/sync-status-dropdown'
import '../src/styles.css'

if (
  import.meta.env.VITE_USE_FIREBASE_EMULATOR !== 'true' ||
  !import.meta.env.VITE_FIREBASE_PROJECT_ID?.startsWith('demo-') ||
  !['localhost', '127.0.0.1'].includes(location.hostname)
)
  throw new Error('Sync status fixture requires disposable demo emulators')
// Direct navigation to a fixture module displays source text; keep the screenshot focused on the component.
document.body.replaceChildren()
const element = document.createElement('div')
element.style.cssText = 'position:fixed;right:60px;top:16px'
document.body.append(element)
const root = createRoot(element)
export function renderStatus(props: Pick<SyncStatusDropdownProps, 'boardId' | 'cloudHistoryEnabled' | 'state'>) {
  root.render(
    <AuthProvider>
      <UserProvider>
        <SyncStatusDropdown
          {...props}
          boardName="Status proof"
          getSceneSize={() => ({ bytes: 100, elementsCount: 1 })}
        />
      </UserProvider>
    </AuthProvider>,
  )
}
export function unmountStatus() {
  root.unmount()
  element.remove()
}
