import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// tvbanned 旧域名版本已停用：仅在 GitHub Pages（tvbanned.github.io）部署下展示停用弹窗，
// 本地 localhost 与 PaleWinds 域名（www.palewinds.com）不展示
const PALEWINDS_URL = 'https://www.palewinds.com/autokey/home'
const IS_TVBANNED_PAGES = window.location.hostname === 'tvbanned.github.io'

function DeprecatedBanner() {
  const [dismissed, setDismissed] = useState(false)
  if (!IS_TVBANNED_PAGES || dismissed) return null
  return (
    <div className="modal-backdrop">
      <section className="modal confirm-dialog" role="alertdialog" aria-modal="true">
        <header><h2>版本停用通知</h2></header>
        <div className="confirm-body">
          <p>本域名版本已停用，请转到 <strong>PaleWinds</strong> 的域名使用 <strong>GameJourney</strong>。</p>
          <div className="confirm-actions">
            <button className="outline-button" onClick={() => setDismissed(true)}>暂不前往</button>
            <button className="primary" onClick={() => { window.location.href = PALEWINDS_URL }}>前往 PaleWinds 版本</button>
          </div>
        </div>
      </section>
    </div>
  )
}

function DeprecatedApp() {
  return (
    <>
      <App />
      <DeprecatedBanner />
    </>
  )
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <DeprecatedApp />
  </StrictMode>,
)
