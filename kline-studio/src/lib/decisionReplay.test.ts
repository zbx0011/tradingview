import { describe, expect, it } from 'vitest'
import type { ReplayDecisionCandidate } from './replayTradeRegistry'
import { replayDecisionCandidates } from './replayTradeRegistry'
import type { Candle } from './market'
import { getSnapshotCandles } from './liveMarket'
import {
  advanceDecisionAttempt, buildDecisionResult, candlesKnownAt, createDecisionAttempt, createDecisionSession,
  decisionShortcutAction, defaultDecisionLevels, evaluatePositionBar, fillPendingOrder,
  decisionResultPnl, historyCoversDecisionCandidate, intervalCutoffTime, parseDecisionReplayStore,
  mergeDecisionReplayStores, pnlForDecision, pnlForDecisionMode, rewardRiskRatio, sampleDecisionCandidates,
  validDecisionLevels, validOpenPositionLevels,
} from './decisionReplay'

function candidate(key: string, side: 'long' | 'short' = 'long'): ReplayDecisionCandidate {
  const [sourceId, number = '1'] = key.split(':')
  return {
    key, sourceId, sourceName: 'V5 回测', symbol: 'XAUUSD', interval: '5m', scenario: 'test', backtestSha256: 'abc',
    trade: {
      tradeNumber: Number(number), side,
      entry: {
        signalIdx: 10, signalTime: 3000, time: 3300, beijingTime: '2026-01-01 00:00', price: 101,
        setup: '突破', reason: '严格因果理由', ruleVersion: 'V5', triggerReference: 'signal high',
        triggerCondition: 'next bar', stopLoss: side === 'long' ? 95 : 105, takeProfit: null,
        noFixedTakeProfitAtEntry: true, stopMethod: 'pivot', trailingActivationUsd: null, trailingDistanceUsd: null,
      },
      exit: {
        idx: 14, time: 4200, beijingTime: '2026-01-01 00:15', price: 103, reasonCode: 'TRAILING_STOP',
        ambiguous: false, finalActiveStop: 103, trailingActivated: true, trailingActivationIdx: 13,
      },
      result: { barsHeld: 3, rMultiple: .4, pnlUsd: 40 },
    },
  }
}

const bar = (time: number, open: number, high: number, low: number, close: number): Candle => ({ time, open, high, low, close, volume: 1 })

describe('decision replay', () => {
  it('samples only unseen unique trades', () => {
    const selected = sampleDecisionCandidates([candidate('a:1'), candidate('a:2'), candidate('b:1')], ['a:2'], 10)
    expect(selected).toHaveLength(2)
    expect(new Set(selected.map((item) => item.key)).size).toBe(2)
    expect(selected.some((item) => item.key === 'a:2')).toBe(false)
  })

  it('cuts minute history at the end of the currently revealed source bar', () => {
    expect(intervalCutoffTime(3000, 300)).toBe(3240)
    const minutes = [bar(3000, 1, 1, 1, 1), bar(3060, 1, 1, 1, 1), bar(3240, 1, 1, 1, 1), bar(3300, 1, 1, 1, 1)]
    expect(candlesKnownAt(minutes, 3240).map((item) => item.time)).toEqual([3000, 3060, 3240])
  })

  it('uses gap-aware stop and limit fills with conservative stop-first exits', () => {
    expect(fillPendingOrder('long', 'stop', 100, bar(0, 103, 105, 102, 104))).toEqual({ time: 0, price: 103 })
    expect(fillPendingOrder('short', 'stop', 100, bar(0, 97, 99, 95, 96))).toEqual({ time: 0, price: 97 })
    expect(fillPendingOrder('long', 'limit', 100, bar(0, 97, 101, 96, 99))).toEqual({ time: 0, price: 97 })
    expect(fillPendingOrder('short', 'limit', 100, bar(0, 103, 104, 99, 101))).toEqual({ time: 0, price: 103 })
    expect(evaluatePositionBar('long', 95, 105, bar(0, 100, 106, 94, 102))).toEqual({ time: 0, price: 95, reason: 'stop-loss' })
  })

  it('admits only candidates with complete signal, entry and exit source candles', () => {
    const item = candidate('a:1')
    const minutes: Candle[] = []
    for (const start of [3000, 3300, 4200]) {
      for (let time = start; time <= start + 240; time += 60) minutes.push(bar(time, 1, 1, 1, 1))
    }
    minutes.sort((left, right) => left.time - right.time)
    expect(historyCoversDecisionCandidate(item, minutes)).toBe(true)
    expect(historyCoversDecisionCandidate(item, minutes.filter((candle) => candle.time !== 4440))).toBe(false)
  })

  it('has fully backed decision questions across the four imported markets', () => {
    const historyBySymbol = new Map<string, Candle[] | null>()
    const eligible = replayDecisionCandidates().filter((item) => {
      if (!historyBySymbol.has(item.symbol)) historyBySymbol.set(item.symbol, getSnapshotCandles(item.symbol, '1m'))
      return historyCoversDecisionCandidate(item, historyBySymbol.get(item.symbol))
    })
    const symbols = new Set(eligible.map((item) => item.symbol))
    expect(eligible.length).toBeGreaterThan(0)
    expect([...symbols]).toEqual(expect.arrayContaining(['XAUUSD', 'XAGUSD', 'BTCUSDT.P', 'US500']))
  })

  it('starts TP at one R and calculates a fixed 100 USD risk result', () => {
    const levels = defaultDecisionLevels('long', 100, 95)
    expect(levels).toEqual({ stopLoss: 95, takeProfit: 105 })
    expect(rewardRiskRatio(100, 95, 110)).toBe(2)
    expect(pnlForDecision('long', 100, 110, 95)).toEqual({ pnlUsd: 200, rMultiple: 2 })
  })

  it('allows a filled position stop to lock profit while retaining its initial fixed-risk sizing', () => {
    expect(validDecisionLevels('long', 100, 102, 105)).toBe(false)
    expect(validOpenPositionLevels('long', 100, 102, 105)).toBe(true)
    expect(validOpenPositionLevels('short', 100, 98, 95)).toBe(true)

    const item = candidate('a:1')
    const attempt = {
      ...createDecisionAttempt(item),
      stage: 'position-open' as const,
      entryMode: 'signal-extreme' as const,
      orderKind: 'stop' as const,
      pendingEntryPrice: 100,
      fill: { time: 3300, price: 100 },
      initialStopLoss: 95,
      stopLoss: 102,
      takeProfit: 105,
    }
    const result = buildDecisionResult(item, attempt, { time: 3600, price: 103, reason: 'manual-close' }, [])
    expect(result.userPnlUsd).toBe(60)
    expect(result.userR).toBeCloseTo(0.6)
  })

  it('advances pending orders and finalizes comparable results without future data', () => {
    const item = candidate('a:1')
    const attempt = { ...createDecisionAttempt(item), stage: 'order-pending' as const, entryMode: 'signal-extreme' as const, orderKind: 'stop' as const, pendingEntryPrice: 100, stopLoss: 95, takeProfit: 105 }
    const evaluation = advanceDecisionAttempt(item, attempt, bar(3300, 100, 106, 94, 101))
    expect(evaluation.attempt.fill).toEqual({ time: 3300, price: 100 })
    expect(evaluation.exit?.reason).toBe('stop-loss')
    const result = buildDecisionResult(item, evaluation.attempt, evaluation.exit!, [])
    expect(result.userPnlUsd).toBe(-100)
    expect(result.systemPnlUsd).toBe(40)
    expect(result.differenceUsd).toBe(-140)
    expect(pnlForDecisionMode('fixed-risk', item.trade.side, result.userEntry!.price, result.userExit.price, result.stopLoss!)).toBe(-100)
    expect(pnlForDecisionMode('fixed-notional', item.trade.side, result.userEntry!.price, result.userExit.price, result.stopLoss!)).toBe(-500)
    expect(decisionResultPnl(result, 'fixed-notional', 'user')).toBe(-500)
    expect(decisionResultPnl(result, 'fixed-notional', 'system')).toBeCloseTo(2 / 101 * 10000)
  })

  it('distinguishes an unfilled order from an intentional skip', () => {
    const item = candidate('a:1')
    const pending = { ...createDecisionAttempt(item), stage: 'order-pending' as const, entryMode: 'free-price' as const, orderKind: 'limit' as const, pendingEntryPrice: 90, stopLoss: 85, takeProfit: 95 }
    expect(buildDecisionResult(item, pending, { time: 4500, price: 103, reason: 'end-of-data' }, []).choice).toBe('unfilled')
    expect(buildDecisionResult(item, createDecisionAttempt(item), { time: 3000, price: 100, reason: 'skipped' }, []).choice).toBe('skipped')
  })

  it('maps numeric shortcuts only in stages where they are valid', () => {
    expect(decisionShortcutAction('entry-decision', '1')).toBe('advance')
    expect(decisionShortcutAction('entry-decision', '2')).toBe('signal-extreme')
    expect(decisionShortcutAction('entry-decision', '3')).toBe('free-price')
    expect(decisionShortcutAction('entry-decision', '4')).toBe('skip')
    expect(decisionShortcutAction('order-pending', '4')).toBe('cancel-pending')
    expect(decisionShortcutAction('position-open', '2')).toBe('manual-close')
    expect(decisionShortcutAction('post-exit', '1')).toBe('advance')
    expect(decisionShortcutAction('post-exit', '4')).toBe('next-trade')
    expect(decisionShortcutAction('post-exit', '2')).toBeNull()
    expect(decisionShortcutAction('risk-setup', '1')).toBe('confirm-risk')
    expect(decisionShortcutAction('risk-setup', '2')).toBe('cancel-setup')
  })

  it('rejects malformed persisted data', () => {
    expect(parseDecisionReplayStore('{bad json')).toMatchObject({ sessions: [], seenTradeKeys: [] })
  })

  it('merges histories from two computers and keeps the more advanced duplicate session', () => {
    const shared = { ...createDecisionSession([candidate('shared:1')], 1, 1000), id: 'shared' }
    const advanced = { ...shared, currentIndex: 1, status: 'completed' as const, updatedAt: 3000, finishedAt: 3000 }
    const localOnly = { ...createDecisionSession([candidate('local:1')], 1, 1100), id: 'local' }
    const importedOnly = { ...createDecisionSession([candidate('imported:1')], 1, 1200), id: 'imported' }
    const merged = mergeDecisionReplayStores(
      { version: 1, seenTradeKeys: ['local:1'], activeSessionId: localOnly.id, sessions: [shared, localOnly] },
      { version: 1, seenTradeKeys: ['shared:1', 'imported:1'], activeSessionId: null, sessions: [advanced, importedOnly] },
    )
    expect(merged.sessions.map((session) => session.id)).toEqual(['imported', 'local', 'shared'])
    expect(merged.sessions.find((session) => session.id === 'shared')).toMatchObject({ status: 'completed', updatedAt: 3000 })
    expect(merged.seenTradeKeys).toEqual(['local:1', 'shared:1', 'imported:1'])
    expect(merged.activeSessionId).toBe('local')
  })
})
