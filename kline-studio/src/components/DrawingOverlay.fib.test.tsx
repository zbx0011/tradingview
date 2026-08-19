import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DrawingOverlay } from './DrawingOverlay'
import { createDefaultFibSettings, type Drawing, type DrawingHistory } from '../lib/drawings'

const fibonacciDrawing = (reverse = false): Drawing => ({
  id: `fib-${reverse ? 'reverse' : 'normal'}`,
  tool: 'fib',
  behavior: 'fib',
  label: '斐波那契回撤',
  points: [
    { x: .25, y: .1, time: 1, price: 500 },
    { x: .75, y: .3, time: 2, price: 400 },
  ],
  color: '#2962ff',
  width: 1.5,
  fib: { ...createDefaultFibSettings(), reverse },
})

const renderFib = (reverse = false) => {
  const drawing = fibonacciDrawing(reverse)
  const history: DrawingHistory = {
    past: [], present: [drawing], future: [], selectedId: drawing.id, selectedIds: [drawing.id],
  }
  return renderToStaticMarkup(<DrawingOverlay
    activeTool="cursor"
    history={history}
    dispatch={vi.fn()}
    color="#2962ff"
    magnetMode="off"
    drawingsLocked={false}
    hidden={false}
    candles={[]}
    symbol="XAUUSD"
    interval="5m"
    quickMeasurement={null}
    onMeasurePoint={() => null}
    onProjectPoint={({ time, price }) => ({ x: time === 1 ? 250 : 750, y: 100 + (500 - price) * 2 })}
    onQuickMeasurementChange={vi.fn()}
    onToolComplete={vi.fn()}
    onZoomSelection={vi.fn()}
    onOpenProperties={vi.fn()}
  />)
}

describe('Fibonacci retracement rendering', () => {
  it('renders TradingView-style levels, price labels, background bands and editable anchors', () => {
    const markup = renderFib()
    expect((markup.match(/data-fib-level=/g) ?? [])).toHaveLength(7)
    expect((markup.match(/data-fib-band=/g) ?? [])).toHaveLength(6)
    expect(markup).toContain('data-fib-label="0"')
    expect(markup).toContain('data-fib-label-y="100"')
    expect(markup).toContain('0 (500.000)')
    expect(markup).toContain('1 (400.000)')
    expect(markup).toContain('font-size="12"')
    expect(markup).toContain('data-drawing-anchor="start"')
    expect(markup).toContain('data-drawing-anchor="end"')
  })

  it('reverses the level direction while preserving the two trend-line anchors', () => {
    const markup = renderFib(true)
    expect(markup).toContain('data-fib-label="0" data-fib-label-y="300"')
    expect(markup).toContain('data-fib-label="1" data-fib-label-y="100"')
    expect(markup).toContain('x1="250" y1="100" x2="750" y2="300"')
  })
})
