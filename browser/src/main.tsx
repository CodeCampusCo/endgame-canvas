import { useState } from 'react'
import { Tldraw } from 'tldraw'
import 'tldraw/tldraw.css'
import { createRoot } from 'react-dom/client'
import { connectRelay } from './connect'

function SupersededBanner() {
  return (
    <div
      style={{
        position: 'fixed',
        top: 12,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 10000,
        background: '#1d1d1d',
        color: '#fff',
        padding: '8px 16px',
        borderRadius: 8,
        fontSize: 13,
        fontFamily: 'sans-serif',
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.25)',
      }}
    >
      Another tab took control of this canvas. Reload this tab to use it here.
    </div>
  )
}

function App() {
  const [superseded, setSuperseded] = useState(false)
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      {superseded && <SupersededBanner />}
      <Tldraw persistenceKey="endgame-canvas" onMount={(editor) => connectRelay(editor, () => setSuperseded(true))} />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
