import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/styles/main.css'
import '@/styles/components.css'
import '@/styles/tailwind.css'
import { ConnectionTooltipOptions } from '@/preview/ConnectionTooltipOptions'

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')

createRoot(container).render(
  <StrictMode>
    <ConnectionTooltipOptions />
  </StrictMode>,
)
