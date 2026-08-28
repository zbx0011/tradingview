import { describe, expect, it } from 'vitest'
import {
  replayDecisionCandidates, replayDecisionContextSourceIds, replayTradeDatasetInfos, resolveReplayDecisionSignalMarker, resolveReplayTradeMarker,
  toReplayDecisionSignalSeriesMarkers, toReplayTradeConnectionSpecs, toReplayTradeSeriesMarkers,
} from './replayTradeRegistry'

describe('replay trade dataset registry', () => {
  const sourceId = 'xauusd-replay-a702a57a46cb7143'
  const v5SourceId = 'xauusd-5m-conservative-stop-first-eaea27ed89715719'

  it('registers the built-in replay as a source-addressable dataset', () => {
    expect(replayTradeDatasetInfos()).toContainEqual(expect.objectContaining({
      sourceId,
      name: 'XAUUSD 回放交易',
      symbol: 'XAUUSD',
      interval: '5m',
      tradeCount: 87,
      markerCount: 174,
    }))
  })

  it('renders only requested layers with source-unique marker and connection IDs', () => {
    const markers = toReplayTradeSeriesMarkers('XAUUSD', '5m', [sourceId])
    const connections = toReplayTradeConnectionSpecs('XAUUSD', '5m', [sourceId])
    expect(markers).toHaveLength(174)
    expect(connections).toHaveLength(87)
    expect(new Set(markers.map((marker) => marker.id)).size).toBe(174)
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
      trade: { tradeNumber: 2 },
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

  it('reveals the later US500 decision signals only when their own signal candle is reached', () => {
    const sourceId = 'us500-5m-conservative-stop-first-7e97f1718d2140c2'
    const initialSignalTime = 1_786_086_300 // 2026-08-07 15:05 Asia/Shanghai, K5902
    const nextOppositeSignalTime = 1_786_090_500 // 2026-08-07 16:15 Asia/Shanghai
    const candidate = replayDecisionCandidates([sourceId]).find((item) => item.trade.entry.signalTime === initialSignalTime)
    expect(candidate).toBeDefined()

    const laterSignals = toReplayDecisionSignalSeriesMarkers('US500', '5m', [sourceId], undefined, initialSignalTime)
    expect(laterSignals.length).toBeGreaterThan(0)
    expect(laterSignals.every((marker) => Number(marker.time) > initialSignalTime)).toBe(true)
    expect(laterSignals.every((marker) => marker.text === '多头信号' || marker.text === '空头信号')).toBe(true)

    expect(Number(laterSignals[0].time)).toBe(nextOppositeSignalTime)
    expect(toReplayDecisionSignalSeriesMarkers('US500', '5m', [sourceId], nextOppositeSignalTime - 1, initialSignalTime)).toEqual([])
    expect(toReplayDecisionSignalSeriesMarkers('US500', '5m', [sourceId], nextOppositeSignalTime, initialSignalTime))
      .toContainEqual(expect.objectContaining({ time: nextOppositeSignalTime, text: '空头信号' }))
  })

  it('keeps the current signal in the causal stream when no lower time bound is supplied', () => {
    const sourceId = 'us500-5m-conservative-stop-first-7e97f1718d2140c2'
    const initialSignalTime = 1_786_086_300
    const nextOppositeSignalTime = 1_786_090_500
    const markers = toReplayDecisionSignalSeriesMarkers('US500', '5m', [sourceId], nextOppositeSignalTime, null)
    expect(markers).toContainEqual(expect.objectContaining({ time: initialSignalTime, text: '多头信号' }))
    expect(markers).toContainEqual(expect.objectContaining({ time: nextOppositeSignalTime, text: '空头信号' }))
  })

  it('keeps adjacent replay sources available for pre-session decision context without duplicate signals', () => {
    const candidates = replayDecisionCandidates()
    const contextSourceIds = replayDecisionContextSourceIds(candidates, 'XAUUSD', '5m')
    expect(contextSourceIds.length).toBeGreaterThan(1)

    const markers = toReplayDecisionSignalSeriesMarkers('XAUUSD', '5m', contextSourceIds)
    const identities = markers.map((marker) => `${Number(marker.time)}:${marker.text}`)
    expect(new Set(identities).size).toBe(identities.length)
    expect(replayDecisionContextSourceIds(candidates, 'BTCUSDT.P', '1m')).toEqual([])
  })

  it('resolves an opposite decision signal to the closing trade detail', () => {
    const sourceId = 'us500-5m-conservative-stop-first-7e97f1718d2140c2'
    const initialSignalTime = 1_786_086_300
    const nextOppositeSignalTime = 1_786_090_500
    const marker = toReplayDecisionSignalSeriesMarkers('US500', '5m', [sourceId], nextOppositeSignalTime, initialSignalTime)
      .find((item) => Number(item.time) === nextOppositeSignalTime && item.text === '空头信号')
    expect(marker?.id).toBeDefined()
    const selection = resolveReplayDecisionSignalMarker('US500', '5m', [sourceId], marker?.id)
    expect(selection).toMatchObject({
      sourceId,
      kind: 'exit',
      signalSide: 'short',
      signalTime: nextOppositeSignalTime,
      trade: { exit: { signalTime: nextOppositeSignalTime } },
    })
    expect(selection?.tradeMarkerId).toContain('-exit')
  })
})
