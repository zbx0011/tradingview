import { describe, expect, it } from 'vitest'
import {
  replayTradeDatasetInfos, resolveReplayTradeMarker, toReplayTradeConnectionSpecs, toReplayTradeSeriesMarkers,
} from './replayTradeRegistry'

describe('replay trade dataset registry', () => {
  const sourceId = 'xauusd-replay-a702a57a46cb7143'
  const v5SourceId = 'xauusd-5m-conservative-stop-first-ce496184a2c3638e'

  it('registers the built-in replay as a source-addressable dataset', () => {
    expect(replayTradeDatasetInfos()).toContainEqual(expect.objectContaining({
      sourceId,
      name: 'XAUUSD 回放交易',
      symbol: 'XAUUSD',
      interval: '5m',
      tradeCount: 94,
      markerCount: 188,
    }))
  })

  it('renders only requested layers with source-unique marker and connection IDs', () => {
    const markers = toReplayTradeSeriesMarkers('XAUUSD', '5m', [sourceId])
    const connections = toReplayTradeConnectionSpecs('XAUUSD', '5m', [sourceId])
    expect(markers).toHaveLength(188)
    expect(connections).toHaveLength(94)
    expect(new Set(markers.map((marker) => marker.id)).size).toBe(188)
    expect(markers[0].id).toContain(sourceId)
    expect(connections[0].sourceId).toBe(sourceId)
    expect(toReplayTradeSeriesMarkers('XAUUSD', '5m', [])).toEqual([])
    expect(toReplayTradeConnectionSpecs('BTCUSDT.P', '5m', [sourceId])).toEqual([])
  })

  it('resolves a marker back to its source layer and trade', () => {
    const marker = toReplayTradeSeriesMarkers('XAUUSD', '5m', [sourceId])[0]
    expect(resolveReplayTradeMarker('XAUUSD', '5m', [sourceId], marker.id)).toMatchObject({
      id: marker.id,
      sourceId,
      trade: { tradeNumber: 1 },
    })
    expect(resolveReplayTradeMarker('XAUUSD', '5m', [], marker.id)).toBeNull()
  })

  it('keeps the replaced V5 layer free of fixed or dynamic course-target exits', () => {
    const trades = toReplayTradeSeriesMarkers('XAUUSD', '5m', [v5SourceId])
      .map((marker) => (typeof marker.id === 'string' && marker.id.endsWith('-entry')
        ? resolveReplayTradeMarker('XAUUSD', '5m', [v5SourceId], marker.id)?.trade
        : null))
      .filter((trade): trade is NonNullable<typeof trade> => trade !== null)
    expect(trades.length).toBeGreaterThan(0)
    expect(trades.every((trade) => trade.entry.takeProfit === null && trade.entry.noFixedTakeProfitAtEntry)).toBe(true)
    expect(trades.some((trade) => trade.exit.reasonCode === 'COURSE_TARGET' || trade.exit.reasonCode === 'COURSE_TARGET_GAP')).toBe(false)
  })
})
