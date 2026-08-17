import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DrawingOverlay } from './DrawingOverlay'
import type { Drawing, DrawingHistory } from '../lib/drawings'

const shortPosition: Drawing = {
  id: 'short-position-test',
  tool: 'short-position',
  behavior: 'short-position',
  label: '空头仓位',
  points: [
    { x: .25, y: .2, time: 1, price: 105 },
    { x: .75, y: .8, time: 2, price: 95 },
  ],
  color: '#2962ff',
  width: 2,
}

const history: DrawingHistory = {
  past: [],
  present: [shortPosition],
  future: [],
  selectedId: shortPosition.id,
  selectedIds: [shortPosition.id],
}

describe('position drawing rendering', () => {
  it('renders the TradingView-style short position zones, labels and four controls', () => {
    const markup = renderToStaticMarkup(<DrawingOverlay
      activeTool="cursor"
      history={history}
      dispatch={vi.fn()}
      color="#2962ff"
      magnetMode="off"
      drawingsLocked={false}
      hidden={false}
      candles={[{ time: 1, open: 101, high: 103, low: 99, close: 102, volume: 100 }]}
      symbol="XAUUSD"
      interval="1m"
      quickMeasurement={null}
      onMeasurePoint={() => null}
      onProjectPoint={({ time, price }) => ({ x: time === 1 ? 250 : 750, y: price === 105 ? 200 : 800 })}
      onQuickMeasurementChange={vi.fn()}
      onToolComplete={vi.fn()}
      onZoomSelection={vi.fn()}
      onOpenProperties={vi.fn()}
    />)

    expect(markup).toContain('data-position-side="short"')
    expect(markup).toContain('data-testid="position-upper-zone"')
    expect(markup).toContain('fill="rgba(242,54,69,.23)"')
    expect(markup).toContain('data-testid="position-lower-zone"')
    expect(markup).toContain('fill="rgba(8,153,129,.22)"')
    expect(markup).toContain('data-testid="position-stop-label"')
    expect(markup).toContain('停止：5 (5%) 500, 金额：750')
    expect(markup).toContain('data-testid="position-entry-label"')
    expect(markup).toContain('开仓 PnL: -10, 数量: 5')
    expect(markup).toContain('风险/回报比: 1')
    expect(markup).toContain('data-testid="position-target-label"')
    expect(markup).toContain('目标：5 (5%) 500, 金额：1250')
    expect(markup).toContain('data-testid="position-control-points"')
    expect(markup.match(/class="position-control-points"[^>]*>.*?<rect/g)?.length).toBe(1)
    expect((markup.match(/stroke="#2962ff"/g) ?? [])).toHaveLength(4)
  })
})
