import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'driver.js/dist/driver.css'
import './index.css'
import App from './App.jsx'
import { applyStoredUiFontScale } from './utils/uiPreferences.js'

applyStoredUiFontScale()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
