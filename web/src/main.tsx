import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { AppProvider } from './store'
import App from './App'
createRoot(document.getElementById('root')!).render(
  <StrictMode><AppProvider><App /></AppProvider></StrictMode>
)
