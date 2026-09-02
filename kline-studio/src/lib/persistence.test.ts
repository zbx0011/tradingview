import { describe, expect, it } from 'vitest'
import { parseDecisionChartStatusPreferences, parseDecisionReplayCenterPreferences, parseDecisionReplayMenuPreferences, parseDecisionReplayPanelPreferences, parseTradeMarkerPanelPreferences, parseWorkspace } from './persistence'

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

  it('restores the indicator legend collapsed state and defaults legacy workspaces to expanded', () => {
    expect(parseWorkspace(JSON.stringify({ ...workspace, indicatorLegendExpanded: false }))).toMatchObject({ indicatorLegendExpanded: false })
    expect(parseWorkspace(JSON.stringify(workspace))).toMatchObject({ indicatorLegendExpanded: true })
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

describe('decision replay panel preferences', () => {
  it('restores the last dragged position and resized dimensions', () => {
    expect(parseDecisionReplayPanelPreferences(JSON.stringify({
      position: { left: 144, top: 96 },
      size: { width: 720, height: 640 },
    }))).toEqual({
      position: { left: 144, top: 96 },
      size: { width: 720, height: 640 },
    })
  })

  it('ignores malformed decision panel layout data', () => {
    expect(parseDecisionReplayPanelPreferences('{broken')).toEqual({ position: null, size: null })
    expect(parseDecisionReplayPanelPreferences(JSON.stringify({
      position: { left: 'bad', top: 96 },
      size: { width: -1, height: 640 },
    }))).toEqual({ position: null, size: null })
  })
})

describe('decision replay menu preferences', () => {
  it('restores the last dragged action menu position', () => {
    expect(parseDecisionReplayMenuPreferences(JSON.stringify({ position: { left: 248, top: 512 } }))).toEqual({
      position: { left: 248, top: 512 },
    })
  })

  it('ignores malformed action menu layout data', () => {
    expect(parseDecisionReplayMenuPreferences('{broken')).toEqual({ position: null })
    expect(parseDecisionReplayMenuPreferences(JSON.stringify({ position: { left: 'bad', top: 512 } }))).toEqual({ position: null })
  })
})

describe('decision chart status preferences', () => {
  it('restores the last dragged PnL panel position', () => {
    expect(parseDecisionChartStatusPreferences(JSON.stringify({ position: { left: 360, top: 72 } }))).toEqual({
      position: { left: 360, top: 72 },
    })
  })

  it('ignores malformed PnL panel layout data', () => {
    expect(parseDecisionChartStatusPreferences('{broken')).toEqual({ position: null })
    expect(parseDecisionChartStatusPreferences(JSON.stringify({ position: { left: 360, top: 'bad' } }))).toEqual({ position: null })
  })
})

describe('decision replay center preferences', () => {
  it('restores the last symbols, sizing modes and trade count', () => {
    expect(parseDecisionReplayCenterPreferences(JSON.stringify({
      count: 50,
      selectedSymbols: ['XAUUSD', 'BTCUSDT.P', 'XAUUSD'],
      selectedModes: ['fixed-notional', 'fixed-notional'],
    }))).toEqual({
      count: 50,
      selectedSymbols: ['XAUUSD', 'BTCUSDT.P'],
      selectedIntervals: ['5m'],
      selectedModes: ['fixed-notional'],
      practiceMode: 'random-count',
      daySequenceScope: 'all-days',
      selectedLossDayKey: null,
      lossDaySizingMode: 'fixed-risk',
    })
  })

  it('restores selected replay intervals and removes unsupported duplicates', () => {
    expect(parseDecisionReplayCenterPreferences(JSON.stringify({
      count: 30,
      selectedSymbols: ['XAUUSD'],
      selectedIntervals: ['15m', '1h', '15m', '30m'],
      selectedModes: ['fixed-risk'],
    }))).toEqual({
      count: 30,
      selectedSymbols: ['XAUUSD'],
      selectedIntervals: ['15m', '1h'],
      selectedModes: ['fixed-risk'],
      practiceMode: 'random-count',
      daySequenceScope: 'all-days',
      selectedLossDayKey: null,
      lossDaySizingMode: 'fixed-risk',
    })
  })

  it('restores the chronological random-day practice mode', () => {
    expect(parseDecisionReplayCenterPreferences(JSON.stringify({
      count: 30,
      selectedSymbols: ['XAUUSD'],
      selectedIntervals: ['5m'],
      selectedModes: ['fixed-risk'],
      practiceMode: 'day-sequence',
    }))?.practiceMode).toBe('day-sequence')
  })

  it('restores the AI loss-day replay scope and selected trading day', () => {
    expect(parseDecisionReplayCenterPreferences(JSON.stringify({
      count: 30,
      selectedSymbols: ['XAUUSD'],
      selectedIntervals: ['5m'],
      selectedModes: ['fixed-risk'],
      practiceMode: 'day-sequence',
      daySequenceScope: 'loss-day',
      selectedLossDayKey: 'XAUUSD:5m:1783288800',
      lossDaySizingMode: 'fixed-notional',
    }))).toMatchObject({
      practiceMode: 'day-sequence',
      daySequenceScope: 'loss-day',
      selectedLossDayKey: 'XAUUSD:5m:1783288800',
      lossDaySizingMode: 'fixed-notional',
    })
  })

  it('migrates the retired AI loss-week preference without reusing its invalid week key', () => {
    expect(parseDecisionReplayCenterPreferences(JSON.stringify({
      count: 30,
      selectedSymbols: ['XAUUSD'],
      selectedIntervals: ['5m'],
      selectedModes: ['fixed-risk'],
      practiceMode: 'day-sequence',
      daySequenceScope: 'loss-week',
      selectedLossWeekKey: 'ai-trading-week:123',
      lossWeekSizingMode: 'fixed-notional',
    }))).toMatchObject({
      practiceMode: 'day-sequence',
      daySequenceScope: 'loss-day',
      selectedLossDayKey: null,
      lossDaySizingMode: 'fixed-notional',
    })
  })

  it('rejects malformed replay center preferences', () => {
    expect(parseDecisionReplayCenterPreferences('{broken')).toBeNull()
    expect(parseDecisionReplayCenterPreferences(JSON.stringify({ count: 0, selectedSymbols: [], selectedModes: [] }))).toBeNull()
    expect(parseDecisionReplayCenterPreferences(JSON.stringify({ count: 30, selectedSymbols: 'XAUUSD', selectedModes: [] }))).toBeNull()
    expect(parseDecisionReplayCenterPreferences(JSON.stringify({ count: 30, selectedSymbols: ['XAUUSD'], selectedIntervals: '5m', selectedModes: [] }))).toBeNull()
  })
})
