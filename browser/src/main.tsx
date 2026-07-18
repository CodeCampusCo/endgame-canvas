import { Tldraw } from 'tldraw'
import 'tldraw/tldraw.css'
import { createRoot } from 'react-dom/client'

function App() {
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Tldraw persistenceKey="endgame-canvas" />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
