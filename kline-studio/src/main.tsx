import { Component, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

const root = document.getElementById('root')!

// The page and #root clip their content (overflow: hidden) but can still be scrolled by the browser, e.g. when
// focus or scrollIntoView reaches an element past the right edge of a wide top bar. That shifted
// the whole page left and hid the left toolbar and the practice panel. The page never scrolls, so
// any such scroll is undone immediately.
const pinned = [document.documentElement, document.body, root]
const unscroll = () => {
  for (const element of pinned) {
    if (element.scrollLeft !== 0) element.scrollLeft = 0
    if (element.scrollTop !== 0) element.scrollTop = 0
  }
}
// Capture phase: scroll events do not bubble, this sees the page and #root scrolling alike.
document.addEventListener('scroll', (event) => {
  if (event.target === document || pinned.includes(event.target as HTMLElement)) unscroll()
}, true)
window.addEventListener('resize', unscroll)
unscroll()

const PAGE_STATE_PREFIX = 'kline-studio-page-state-v1:'

/**
 * A render error used to leave a blank page. Show what broke instead, with a way back:
 * reload, or reload after forgetting the on-screen state (open dialogs, selections …).
 * Practice papers, drawings and settings are kept.
 */
class CrashScreen extends Component<{ children: ReactNode }, { error: Error | null; stack: string }> {
  state = { error: null as Error | null, stack: '' }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[K线工坊] 页面渲染出错', error, info.componentStack)
    this.setState({ stack: info.componentStack ?? '' })
  }
  render() {
    const { error, stack } = this.state
    if (!error) return this.props.children
    const resetView = () => {
      try { for (const key of Object.keys(localStorage)) if (key.startsWith(PAGE_STATE_PREFIX)) localStorage.removeItem(key) } catch { /* storage blocked */ }
      location.reload()
    }
    return <div style={{ padding: 32, color: '#e5e7eb', background: '#111827', minHeight: '100vh', boxSizing: 'border-box', fontFamily: 'system-ui, sans-serif', overflow: 'auto' }}>
      <h2 style={{ marginTop: 0 }}>页面出错了</h2>
      <p>复盘进度、画线和设置都还在。可以先直接重新加载；如果还是出错，点第二个按钮（只清掉当前打开的窗口、选中项等界面状态）。</p>
      <p style={{ display: 'flex', gap: 12 }}>
        <button type="button" onClick={() => location.reload()}>重新加载</button>
        <button type="button" onClick={resetView}>清除界面状态后重新加载</button>
      </p>
      <p>把下面这段错误信息截图发给我，方便修复：</p>
      <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, background: '#0b1220', padding: 12, borderRadius: 8 }}>{String(error.stack || error.message)}{stack}</pre>
    </div>
  }
}

// StrictMode is intentionally not used: the local launcher runs the Vite dev
// server, where StrictMode renders every component twice. That doubled the
// cost of each chart re-render and made panning/zooming noticeably heavier.
createRoot(root).render(<CrashScreen><App /></CrashScreen>)
