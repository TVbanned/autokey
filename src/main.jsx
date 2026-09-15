import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// #region debug-point A:page-lifecycle
const debugReport = (hypothesisId, msg, data = {}) => fetch('http://127.0.0.1:7778/event', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'trae-tab-disappearing', runId: 'pre-fix', hypothesisId, location: 'src/main.jsx', msg: `[DEBUG] ${msg}`, data: { ...data, href: window.location.href, visibilityState: document.visibilityState }, ts: Date.now() }) }).catch(() => {})
window.addEventListener('pagehide', (event) => debugReport('A', 'pagehide', { persisted: event.persisted }))
document.addEventListener('visibilitychange', () => debugReport('A', 'visibilitychange'))
window.addEventListener('error', (event) => debugReport('D', 'uncaught-error', { message: event.message, source: event.filename, line: event.lineno, column: event.colno }))
window.addEventListener('unhandledrejection', (event) => debugReport('D', 'unhandled-rejection', { reason: String(event.reason) }))
// #endregion

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
