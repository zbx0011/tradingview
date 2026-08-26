import { describe, expect, it } from 'vitest'
import type { Candle } from './market'
import {
  buildDecisionResult,
  createDecisionAttempt,
  createDecisionSession,
  decisionStopLossMode,
  type DecisionReplaySession,
  type DecisionTradeResult,
} from './decisionReplay'
import {
  createDecisionAnomalyReviewSession,
  findDecisionReplayAnomalies,
} from './decisionReplayAnomalies'
import type { ReplayDecisionCandidate } from './replayTradeRegistry'

const bar = (time: number, open: number, high: number, low: number, close: number): Candle => ({
  time,
  open,
  high,
  low,
  close,
  volume: 1,
})

function candidate(
  key: string,
  options: { side?: 'long' | 'short'; entryTime?: number; exitTime?: number } = {},
): ReplayDecisionCandidate {
  const side = options.side ?? 'long'
  const entryTime = options.entryTime ?? 3300
  const exitTime = options.exitTime ?? 4200
  return {
    key,
    sourceId: 'xauusd-test',
    sourceName: 'V5 回测',
    symbol: 'XAUUSD',
    interval: '5m',
    scenario: 'anomaly-test',
    backtestSha256: 'anomaly-test-sha',
    trade: {
      tradeNumber: Number(key.replace(/\D/g, '') || 1),
      side,
      entry: {
        signalIdx: 10,
        signalTime: 3000,
        time: entryTime,
        beijingTime: '2026-01-01 00:00',
        price: 100,
        setup: '突破',
        reason: '严格因果理由',
        ruleVersion: 'V5',
        triggerReference: 'signal high',
        triggerCondition: 'next bar',
        stopLoss: side === 'long' ? 95 : 105,
        takeProfit: null,
        noFixedTakeProfitAtEntry: true,
        stopMethod: 'pivot',
        trailingActivationUsd: null,
        trailingDistanceUsd: null,
      },
      exit: {
        idx: 14,
        time: exitTime,
        beijingTime: '2026-01-01 00:15',
        price: side === 'long' ? 103 : 97,
        reasonCode: 'TRAILING_STOP',
        ambiguous: false,
        finalActiveStop: side === 'long' ? 103 : 97,
        trailingActivated: true,
        trailingActivationIdx: 13,
      },
      result: { barsHeld: 3, rMultiple: 0.4, pnlUsd: 40 },
    },
  }
}

function resultFor(
  item: ReplayDecisionCandidate,
  mode: 'touch' | 'close',
  exitTime = 3600,
  exitPrice = item.trade.side === 'long' ? 95 : 105,
): DecisionTradeResult {
  const stopLoss = item.trade.entry.stopLoss!
  const attempt = {
    ...createDecisionAttempt(item),
    stage: 'position-open' as const,
    entryMode: 'signal-extreme' as const,
    orderKind: 'stop' as const,
    pendingEntryPrice: item.trade.entry.price,
    initialStopLoss: stopLoss,
    stopLossMode: mode,
    stopLoss,
    fill: { time: item.trade.entry.time, price: item.trade.entry.price },
  }
  return buildDecisionResult(item, attempt, { time: exitTime, price: exitPrice, reason: 'stop-loss' }, [])
}

function completedSession(
  result: DecisionTradeResult,
  id: string,
  options: { reviewKind?: 'stop-anomalies' } = {},
): DecisionReplaySession {
  const base = createDecisionSession([result.candidate], 1, 1000)
  return {
    ...base,
    id,
    attempts: [{ ...base.attempts[0], stage: 'complete', result }],
    currentIndex: 0,
    status: 'completed',
    updatedAt: 2000,
    finishedAt: 2000,
    ...(options.reviewKind ? { reviewKind: options.reviewKind } : {}),
  }
}

describe('decision replay stop-loss anomaly review', () => {
  it('flags legacy touch stops that disagree with the current XAUUSD 5m candle or predate entry, but skips close mode', () => {
    const mismatched = resultFor(candidate('legacy-mismatch:1'), 'touch', 3600, 94)
    const beforeEntryItem = candidate('legacy-before-entry:2', { exitTime: 3000 })
    const beforeEntry = resultFor(beforeEntryItem, 'touch', 3600, 95)
    const closeMode = resultFor(candidate('new-close:3'), 'close', 3600, 94)
    const candles = [
      // The mismatch bar never reaches the long stop at 95, and the stored fill
      // at 94 also disagrees with the gap-aware touch fill expected from it.
      bar(3000, 100, 101, 99, 100),
      bar(3600, 100, 101, 96, 97),
      bar(4200, 100, 104, 99, 103),
    ]

    const anomalies = findDecisionReplayAnomalies([
      completedSession(mismatched, 'source-mismatch'),
      completedSession(beforeEntry, 'source-before-entry'),
      completedSession(closeMode, 'source-close'),
    ], candles)

    expect(anomalies).toHaveLength(2)
    const mismatch = anomalies.find((item) => item.sessionId === 'source-mismatch')!
    expect(mismatch.reasons).toEqual(expect.arrayContaining([
      '原止损未被当前OANDA该K触碰',
      '原止损成交与当前K线不一致',
    ]))
    const preEntry = anomalies.find((item) => item.sessionId === 'source-before-entry')!
    expect(preEntry.reasons).toContain('系统在用户开仓前已退出')
    expect(anomalies.some((item) => item.sessionId === 'source-close')).toBe(false)
  })

  it('treats a missing legacy result mode as touch and skips an already-created anomaly review session', () => {
    const item = candidate('legacy-missing-mode:1')
    const result = resultFor(item, 'touch', 3600, 94)
    const { stopLossMode: _legacyMode, ...missingModeResult } = result
    expect(_legacyMode).toBe('touch')
    const legacyResult = missingModeResult as DecisionTradeResult
    expect(decisionStopLossMode(legacyResult.stopLossMode)).toBe('touch')

    const anomalies = findDecisionReplayAnomalies([
      completedSession(legacyResult, 'legacy-source'),
      completedSession(legacyResult, 'already-reviewed', { reviewKind: 'stop-anomalies' }),
    ], [
      bar(3600, 100, 101, 96, 97),
      bar(4200, 100, 104, 99, 103),
    ])

    expect(anomalies).toHaveLength(1)
    expect(anomalies[0].sessionId).toBe('legacy-source')
    expect(anomalies[0].result.stopLossMode).toBeUndefined()
  })

  it('creates an independent deduplicated review batch without mutating anomaly source records', () => {
    const first = resultFor(candidate('redo:1'), 'touch', 3600, 94)
    const second = resultFor(candidate('redo:2'), 'touch', 3600, 94)
    const anomalies = [
      { sessionId: 'source-a', result: first, reasons: ['原止损未被当前OANDA该K触碰'] },
      { sessionId: 'source-b', result: first, reasons: ['原止损成交与当前K线不一致'] },
      { sessionId: 'source-c', result: second, reasons: ['系统在用户开仓前已退出'] },
    ]
    const before = JSON.stringify(anomalies)

    const review = createDecisionAnomalyReviewSession(anomalies, ['fixed-risk'], 12345)

    expect(review.origin).toBe('review')
    expect(review.reviewKind).toBe('stop-anomalies')
    expect(review.startedAt).toBe(12345)
    expect(review.positionSizingModes).toEqual(['fixed-risk'])
    expect(review.requestedCount).toBe(2)
    expect(review.candidates.map((item) => item.key)).toEqual(['redo:1', 'redo:2'])
    expect(review.attempts).toHaveLength(1)
    expect(review.attempts[0].candidateKey).toBe('redo:1')
    expect(review.attempts[0].stopLossMode).toBe('close')
    expect(review.attempts[0].result).toBeNull()
    expect(review.reviewSourceRecords).toEqual([
      { sessionId: 'source-a', candidateKey: 'redo:1' },
      { sessionId: 'source-b', candidateKey: 'redo:1' },
      { sessionId: 'source-c', candidateKey: 'redo:2' },
    ])
    expect(JSON.stringify(anomalies)).toBe(before)
  })
})
