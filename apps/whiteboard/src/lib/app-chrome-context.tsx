import { createContext, useContext, useState, type ReactNode } from 'react'

const AppChromeContext = createContext({
  presentationActive: false,
  setPresentationActive: (_active: boolean) => {},
})

/** Presentation routes and presentation-access boards share the same app layout. */
export function AppChromeProvider({ children }: { children: ReactNode }) {
  const [presentationActive, setPresentationActive] = useState(false)
  return (
    <AppChromeContext.Provider value={{ presentationActive, setPresentationActive }}>
      {children}
    </AppChromeContext.Provider>
  )
}

export const useAppChrome = () => useContext(AppChromeContext)
