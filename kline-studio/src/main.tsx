import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// StrictMode is intentionally not used: the local launcher runs the Vite dev
// server, where StrictMode renders every component twice. That doubled the
// cost of each chart re-render and made panning/zooming noticeably heavier.
createRoot(document.getElementById('root')!).render(<App />)
