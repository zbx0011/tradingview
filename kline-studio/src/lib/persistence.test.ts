import { describe, expect, it } from 'vitest'
import { parseTradeMarkerPanelPreferences, parseWorkspace } from './persistence'

const workspace = {
  symbol: 'XAUUSD',
  interval: '1m',
  chartType: 'candles',
  theme: 'dark',
  indicators: {
    ma: true,
    ema: false,
    boll: false,
    volume: true,
    maPeriod: 20,
    emaPeriod: 9,
    bollPeriod: 20,
    bollDeviation: 2,
  },
  drawings: [],
}

describe('workspace price scale state', () => {
  it('migrates legacy MA workspaces to the required EMA20 profile', () => {
    expect(parseWorkspace(JSON.stringify(workspace))).toMatchObject({
      indicatorProfileVersion: 1,
      indicators: { ma: false, ema: true, emaPeriod: 20 },
    })
  })

  it('preserves later intentional indicator changes after migration', () => {
    expect(parseWorkspace(JSON.stringify({
      ...workspace,
      indicatorProfileVersion: 1,
      indicators: { ...workspace.indicators, ma: true, ema: false, emaPeriod: 50 },
    }))).toMatchObject({
      indicators: { ma: true, ema: false, emaPeriod: 50 },
    })
  })

  it('keeps TradingView-compatible defaults for older saved workspaces', () => {
    expect(parseWorkspace(JSON.stringify(workspace))).toMatchObject({
      priceScaleAuto: true,
      priceScaleLog: false,
    })
  })

  it('restores the automatic and logarithmic scale toggles', () => {
    expect(parseWorkspace(JSON.stringify({
      ...workspace,
      priceScaleAuto: false,
      priceScaleLog: true,
    }))).toMatchObject({
      priceScaleAuto: false,
      priceScaleLog: true,
    })
  })

  it('restores only valid collapsed replay-range layer ids', () => {
    expect(parseWorkspace(JSON.stringify({
      ...workspace,
      collapsedReplayRangeLayerIds: ['range-a', 42, '', null, 'range-b'],
    }))).toMatchObject({ collapsedReplayRangeLayerIds: ['range-a', 'range-b'] })
  })
})

describe('trade marker panel preferences', () => {
  it('restores the last dragged position and font size', () => {
    expect(parseTradeMarkerPanelPreferences(JSON.stringify({
      position: { left: 612, top: 84 },
      size: { width: 420, height: 560 },
      fontSize: 'large',
    }))).toEqual({
      position: { left: 612, top: 84 },
      size: { width: 420, height: 560 },
      fontSize: 'large',
    })
  })

  it('falls back safely when saved preferences are invalid', () => {
    expect(parseTradeMarkerPanelPreferences('{broken')).toEqual({ position: null, size: null, fontSize: 'medium' })
    expect(parseTradeMarkerPanelPreferences(JSON.stringify({
      position: { left: 'bad', top: 84 },
      size: { width: 0, height: 560 },
      fontSize: 'huge',
    }))).toEqual({ position: null, size: null, fontSize: 'medium' })
  })
})
