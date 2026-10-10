import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { router } from './router'
import { installChunkRecovery } from './lib/chunk-recovery'
import { registerWhiteboardFonts } from './features/fonts/whiteboard-fonts'
import { FontLoadingFeedback } from './features/fonts/font-loading-feedback'
import '@excalidraw/excalidraw/index.css'
import './styles.css'

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } })
registerWhiteboardFonts()
installChunkRecovery()
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <FontLoadingFeedback />
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
