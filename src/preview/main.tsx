/**
 * Preview entry for the home-title options page.
 *
 * Loads the same stylesheet chain as the app (design tokens → hand-written
 * components → Tailwind layer) so the shadcn tokens resolve against the real
 * palette. The app shell is not mounted: this page only shows PixelHeading.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/styles/main.css'
import '@/styles/components.css'
import '@/styles/tailwind.css'
import { HomeTitleOptions } from '@/preview/HomeTitleOptions'

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')

createRoot(container).render(
  <StrictMode>
    <HomeTitleOptions />
  </StrictMode>,
)
