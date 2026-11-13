import '@fontsource-variable/inter/wght.css'
import '@fontsource-variable/space-grotesk/wght.css'
import './styles.css'
import { StrictMode, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AppProvider, Layout } from './app'
import { Board } from './Board'
import { Auth, NotFound } from './Public'

// Split out: the landing page carries the animation library, and the team page is only needed after a click.
const Landing = lazy(() => import('./Landing'))
const TeamPage = lazy(() => import('./Team').then((mod) => ({ default: mod.TeamPage })))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AppProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Landing />} />
            <Route path="login" element={<Auth mode="login" />} />
            <Route path="signup" element={<Auth mode="signup" />} />
            <Route path="board" element={<Board />} />
            <Route path="teams/:id" element={<TeamPage />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </AppProvider>
    </BrowserRouter>
  </StrictMode>,
)
