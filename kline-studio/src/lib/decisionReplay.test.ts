import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import snapshotManifest from '../data/marketSnapshotManifest.json'
import type { ReplayDecisionCandidate } from './replayTradeRegistry'
import { replayDecisionCandidates } from './replayTradeRegistry'
import type { Candle } from './market'
import { parseCompactHistory } from './liveMarket'
import {
  adjacentDecisionExerciseTarget, advanceDecisionAttempt, buildDecisionResult, cancelPendingOrderAndAdvance, candlesKnownAt, compareDecisionHistorySortValues, createDecisionAttempt, createDecisionReviewSession, createDecisionSession,
  decisionAttemptSide, decisionDayCandidateGroups, decisionDayHistoryIsComplete, decisionResultSide, decisionSessionPracticeMode, decisionShortcutAction, defaultDecisionLevels, evaluatePositionBar, fillPendingOrder,
  decisionResultPnl, decisionResultR, decisionSessionUserRStats, decisionStopLossMode, emptyDecisionReplayStore, filterDecisionCandidatesByScope, historyCoversDecisionCandidate, intervalCutoffTime, parseDecisionReplayStore,
  mergeDecisionReplayStores, normalizeDecisionReplayStore, persistDecisionReplayStoreAdditively, pnlForDecision, pnlForDecisionMode, restartPostExitDecisionAttempt, rewardRiskRatio, sampleDecisionCandidates, sampleDecisionDayCandidates,
  saveDecisionReplayStore, saveDecisionReplayStoreSnapshot, serializeDecisionReplayStore, updateDecisionSessionDrawings, validDecisionLevels, validOpenPositionLevels, type DecisionReplaySession,
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

function storeWithSessions(...sessions: DecisionReplaySession[]) {
  return {
    version: 1 as const,
    seenTradeKeys: [...new Set(sessions.flatMap((session) => session.candidates.map((item) => item.key)))],
    activeSessionId: sessions.find((session) => session.status === 'active')?.id ?? null,
    sessions,
  }
}

const bar = (time: number, open: number, high: number, low: number, close: number): Candle => ({ time, open, high, low, close, volume: 1 })

describe('decision replay', () => {
  it('sorts per-trade history by time or selected-position PnL in either direction', () => {
    const olderLoss = { startedAt: 100, ordinal: 1, pnlUsd: -20 }
    const newerWin = { startedAt: 200, ordinal: 1, pnlUsd: 30 }
    const newestPending = { startedAt: 300, ordinal: 1, pnlUsd: null }
    const values = [olderLoss, newestPending, newerWin]

    expect([...values].sort((left, right) => compareDecisionHistorySortValues(left, right, 'time-desc'))).toEqual([newestPending, newerWin, olderLoss])
    expect([...values].sort((left, right) => compareDecisionHistorySortValues(left, right, 'time-asc'))).toEqual([olderLoss, newerWin, newestPending])
    expect([...values].sort((left, right) => compareDecisionHistorySortValues(left, right, 'pnl-desc'))).toEqual([newerWin, olderLoss, newestPending])
    expect([...values].sort((left, right) => compareDecisionHistorySortValues(left, right, 'pnl-asc'))).toEqual([olderLoss, newerWin, newestPending])
  })

  it('samples only unseen unique trades', () => {
    const selected = sampleDecisionCandidates([candidate('a:1'), candidate('a:2'), candidate('b:1')], ['a:2'], 10)
    expect(selected).toHaveLength(2)
    expect(new Set(selected.map((item) => item.key)).size).toBe(2)
    expect(selected.some((item) => item.key === 'a:2')).toBe(false)
  })

  it('deduplicates repeated candidate keys before sampling', () => {
    const selected = sampleDecisionCandidates([candidate('same:1'), candidate('same:1'), candidate('other:1')], [], 10)
    expect(selected).toHaveLength(2)
    expect(new Set(selected.map((item) => item.key))).toEqual(new Set(['same:1', 'other:1']))
  })

  it('filters random exercises by both selected symbol and timeframe', () => {
    const fiveMinute = candidate('five:1')
    const fifteenMinute = { ...candidate('fifteen:1'), interval: '15m' as const }
    const oneHour = { ...candidate('hour:1'), symbol: 'XAGUSD' as const, interval: '1h' as const }
    const candidates = [fiveMinute, fifteenMinute, oneHour]

    expect(filterDecisionCandidatesByScope(candidates, ['XAUUSD'], ['15m']).map((item) => item.key)).toEqual(['fifteen:1'])
    expect(filterDecisionCandidatesByScope(candidates, ['XAUUSD', 'XAGUSD'], ['5m', '1h']).map((item) => item.key)).toEqual(['five:1', 'hour:1'])
    expect(filterDecisionCandidatesByScope(candidates, ['XAGUSD'], ['15m'])).toEqual([])
  })

  it('groups one Beijing date by symbol and timeframe, then orders its questions chronologically', () => {
    const beijingDayStart = Date.UTC(2025, 11, 31, 16) / 1000
    const marketOpen = beijingDayStart + 6 * 60 * 60
    const timed = (key: string, signalOffset: number, symbol: ReplayDecisionCandidate['symbol'] = 'XAUUSD', interval: ReplayDecisionCandidate['interval'] = '5m') => {
      const item = candidate(key)
      const signalTime = beijingDayStart + signalOffset
      return {
        ...item,
        symbol,
        interval,
        trade: {
          ...item.trade,
          entry: { ...item.trade.entry, signalTime, time: signalTime + 300 },
          exit: { ...item.trade.exit, time: signalTime + 900 },
        },
      }
    }
    const later = timed('day:2', 6 * 60 * 60 + 3_600)
    const earlier = timed('day:1', 6 * 60 * 60 + 1_800)
    const otherSymbol = timed('day:3', 6 * 60 * 60 + 2_400, 'XAGUSD')

    const groups = decisionDayCandidateGroups([later, otherSymbol, earlier], [])
    expect(groups).toHaveLength(2)
    expect(groups.find((group) => group.daySequence.symbol === 'XAUUSD')?.candidates.map((item) => item.key)).toEqual(['day:1', 'day:2'])
    expect(groups.find((group) => group.daySequence.symbol === 'XAUUSD')?.daySequence).toMatchObject({
      interval: '5m', startTime: marketOpen, endTime: beijingDayStart + 29 * 60 * 60,
    })
  })

  it('samples a single chronological day without reusing seen or cross-date trades', () => {
    const beijingDayStart = Date.UTC(2025, 11, 31, 16) / 1000
    const first = candidate('day-sample:1')
    const second = candidate('day-sample:2')
    const at = (item: ReplayDecisionCandidate, signalOffset: number, exitOffset = signalOffset + 900): ReplayDecisionCandidate => ({
      ...item,
      trade: {
        ...item.trade,
        entry: { ...item.trade.entry, signalTime: beijingDayStart + signalOffset, time: beijingDayStart + signalOffset + 300 },
        exit: { ...item.trade.exit, time: beijingDayStart + exitOffset },
      },
    })
    const crossDate = at(candidate('day-sample:cross'), 28 * 60 * 60 + 50 * 60, 29 * 60 * 60 + 5 * 60)
    const sampled = sampleDecisionDayCandidates([
      at(second, 6 * 60 * 60 + 3_600),
      crossDate,
      at(first, 6 * 60 * 60 + 1_800),
    ], ['day-sample:2'])

    expect(sampled?.candidates.map((item) => item.key)).toEqual(['day-sample:1'])
    expect(decisionSessionPracticeMode(createDecisionSession(sampled!.candidates, 1, 1, undefined, {
      practiceMode: 'day-sequence', daySequence: sampled!.daySequence,
    }))).toBe('day-sequence')
  })

  it('requires both session-edge candles before a day can be sampled', () => {
    const beijingDayStart = Date.UTC(2025, 11, 31, 16) / 1000
    const marketOpen = beijingDayStart + 6 * 60 * 60
    const marketClose = beijingDayStart + 29 * 60 * 60
    const item = candidate('day-complete:1')
    const candidateInSession: ReplayDecisionCandidate = {
      ...item,
      trade: {
        ...item.trade,
        entry: { ...item.trade.entry, signalTime: marketOpen + 3_600, time: marketOpen + 3_900 },
        exit: { ...item.trade.exit, time: marketOpen + 4_500 },
      },
    }
    const group = decisionDayCandidateGroups([candidateInSession], [])[0]
    const complete = [bar(marketOpen, 1, 1, 1, 1), bar(marketClose - 300, 1, 1, 1, 1)]

    expect(decisionDayHistoryIsComplete(group.daySequence, complete)).toBe(true)
    expect(decisionDayHistoryIsComplete(group.daySequence, complete.slice(1))).toBe(false)
    expect(sampleDecisionDayCandidates([candidateInSession], [], ({ daySequence }) => (
      decisionDayHistoryIsComplete(daySequence, complete.slice(1))
    ))).toBeNull()
  })

  it('repairs an active legacy calendar-day session to market-open bounds', () => {
    const beijingDayStart = Date.UTC(2025, 11, 31, 16) / 1000
    const marketOpen = beijingDayStart + 6 * 60 * 60
    const item = candidate('legacy-day:1')
    const candidateInSession: ReplayDecisionCandidate = {
      ...item,
      trade: {
        ...item.trade,
        entry: { ...item.trade.entry, signalTime: marketOpen + 3_600, time: marketOpen + 3_900 },
        exit: { ...item.trade.exit, time: marketOpen + 4_500 },
      },
    }
    const created = createDecisionSession([candidateInSession], 1, 1, undefined, {
      practiceMode: 'day-sequence',
      daySequence: {
        key: 'XAUUSD:5m:legacy', symbol: 'XAUUSD', interval: '5m',
        startTime: beijingDayStart, endTime: beijingDayStart + 24 * 60 * 60,
      },
    })
    const session = {
      ...created,
      // Versions before day-tape playback initialized the untouched first
      // question directly at its signal candle.
      attempts: created.attempts.map((attempt) => ({ ...attempt, cursorTime: candidateInSession.trade.entry.signalTime })),
    }

    const repaired = normalizeDecisionReplayStore(storeWithSessions(session)).sessions[0]
    expect(repaired.daySequence).toMatchObject({
      startTime: marketOpen,
      endTime: beijingDayStart + 29 * 60 * 60,
    })
    expect(repaired.attempts[0].cursorTime).toBe(marketOpen)
  })

  it('starts a new day-sequence session at the first market candle, not the first signal', () => {
    const item = candidate('day-open:1')
    const session = createDecisionSession([item], 1, 1, undefined, {
      practiceMode: 'day-sequence',
      daySequence: { key: 'day-open', symbol: 'XAUUSD', interval: '5m', startTime: 600, endTime: 86_400 },
    })

    expect(session.attempts[0].cursorTime).toBe(600)
    expect(session.attempts[0].cursorTime).toBeLessThan(item.trade.entry.signalTime)
  })

  it('cuts minute history at the end of the currently revealed source bar', () => {
    expect(intervalCutoffTime(3000, 300)).toBe(3240)
    const minutes = [bar(3000, 1, 1, 1, 1), bar(3060, 1, 1, 1, 1), bar(3240, 1, 1, 1, 1), bar(3300, 1, 1, 1, 1)]
    expect(candlesKnownAt(minutes, 3240).map((item) => item.time)).toEqual([3000, 3060, 3240])
  })

  it('uses gap-aware stop and limit fills with conservative stop-first exits', () => {
    expect(fillPendingOrder('long', 'stop', 100, bar(0, 103, 105, 102, 104))).toEqual({ time: 0, price: 103 })
    expect(fillPendingOrder('short', 'stop', 100, bar(0, 97, 99, 95, 96))).toEqual({ time: 0, price: 97 })
    expect(fillPendingOrder('long', 'stop', 100, bar(0, 99, 100, 98, 99))).toBeNull()
    expect(fillPendingOrder('short', 'stop', 100, bar(0, 101, 102, 100, 101))).toBeNull()
    expect(fillPendingOrder('long', 'limit', 100, bar(0, 97, 101, 96, 99))).toEqual({ time: 0, price: 97 })
    expect(fillPendingOrder('short', 'limit', 100, bar(0, 103, 104, 99, 101))).toEqual({ time: 0, price: 103 })
    expect(evaluatePositionBar('long', 95, 105, bar(0, 100, 106, 94, 102))).toEqual({ time: 0, price: 95, reason: 'stop-loss' })
  })

  it('defaults new attempts to close stops while legacy mode values remain touch-compatible', () => {
    const item = candidate('mode-default:1')
    expect(createDecisionAttempt(item).stopLossMode).toBe('close')
    expect(decisionStopLossMode(undefined)).toBe('touch')
    expect(decisionStopLossMode('legacy-value')).toBe('touch')
    expect(decisionStopLossMode('close')).toBe('close')
  })

  it('evaluates close stops from the actual close for both sides, with equality not triggering', () => {
    expect(evaluatePositionBar('long', 95, 110, bar(300, 100, 105, 90, 96), 'close')).toBeNull()
    expect(evaluatePositionBar('long', 95, 110, bar(600, 100, 105, 90, 95), 'close')).toBeNull()
    expect(evaluatePositionBar('long', 95, 110, bar(900, 100, 105, 90, 94), 'close')).toEqual({ time: 900, price: 94, reason: 'stop-loss' })

    expect(evaluatePositionBar('short', 105, 90, bar(300, 100, 110, 95, 104), 'close')).toBeNull()
    expect(evaluatePositionBar('short', 105, 90, bar(600, 100, 110, 95, 105), 'close')).toBeNull()
    expect(evaluatePositionBar('short', 105, 90, bar(900, 100, 110, 95, 106), 'close')).toEqual({ time: 900, price: 106, reason: 'stop-loss' })
  })

  it('lets an intrabar target win before a close-confirmed stop and records the actual close price', () => {
    expect(evaluatePositionBar('long', 102, 110, bar(300, 100, 111, 99, 101), 'close')).toEqual({ time: 300, price: 110, reason: 'take-profit' })
    expect(evaluatePositionBar('short', 98, 90, bar(600, 100, 101, 89, 99), 'close')).toEqual({ time: 600, price: 90, reason: 'take-profit' })

    const item = candidate('close-profit:1')
    const attempt = {
      ...createDecisionAttempt(item),
      stage: 'position-open' as const,
      entryMode: 'signal-extreme' as const,
      orderKind: 'stop' as const,
      pendingEntryPrice: 100,
      initialStopLoss: 95,
      stopLossMode: 'close' as const,
      stopLoss: 102,
      takeProfit: 110,
      fill: { time: 3300, price: 100 },
    }
    const exit = evaluatePositionBar('long', 102, 110, bar(3600, 100, 104, 100, 101), 'close')!
    const result = buildDecisionResult(item, attempt, exit, [])
    expect(exit).toEqual({ time: 3600, price: 101, reason: 'stop-loss' })
    expect(result.stopLossMode).toBe('close')
    expect(result.userPnlUsd).toBe(20)
    expect(result.userPnlUsd).toBeLessThan((102 - 100) / (100 - 95) * 100)
  })

  it('preserves legacy touch stop-first and gap execution semantics', () => {
    expect(evaluatePositionBar('long', 95, 110, bar(300, 93, 112, 90, 108), 'touch')).toEqual({ time: 300, price: 93, reason: 'stop-loss' })
    expect(evaluatePositionBar('short', 105, 90, bar(600, 107, 110, 88, 92), 'touch')).toEqual({ time: 600, price: 107, reason: 'stop-loss' })
  })

  it('uses a newly reached system exit only for close mode and never leaks past or future exits', () => {
    const item = { ...candidate('system:1'), trade: { ...candidate('system:1').trade, exit: { ...candidate('system:1').trade.exit, time: 3600, price: 104 } } }
    const closeAttempt = {
      ...createDecisionAttempt(item),
      stage: 'position-open' as const,
      pendingEntryPrice: 100,
      initialStopLoss: 95,
      stopLossMode: 'close' as const,
      stopLoss: 95,
      takeProfit: 120,
      fill: { time: 3300, price: 100 },
    }
    expect(advanceDecisionAttempt(item, closeAttempt, bar(3600, 100, 106, 90, 94)).exit).toEqual({ time: 3600, price: 104, reason: 'system-exit' })

    const touchAttempt = { ...closeAttempt, stopLossMode: 'touch' as const }
    expect(advanceDecisionAttempt(item, touchAttempt, bar(3600, 100, 106, 99, 104)).exit).toBeNull()

    const beforeEntry = { ...item, trade: { ...item.trade, exit: { ...item.trade.exit, time: 3000 } } }
    expect(advanceDecisionAttempt(beforeEntry, closeAttempt, bar(3600, 100, 106, 99, 104)).exit).toBeNull()

    const afterCurrent = { ...item, trade: { ...item.trade, exit: { ...item.trade.exit, time: 4200 } } }
    expect(advanceDecisionAttempt(afterCurrent, closeAttempt, bar(3600, 100, 106, 99, 104)).exit).toBeNull()
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

  it('accepts a native 5-minute replay tape without pretending it is one-minute data', () => {
    const nativeFiveMinuteBars: Candle[] = []
    for (let time = 3000; time <= 4440; time += 300) nativeFiveMinuteBars.push(bar(time, 1, 1, 1, 1))
    expect(historyCoversDecisionCandidate(candidate('a:1'), nativeFiveMinuteBars)).toBe(true)
    expect(historyCoversDecisionCandidate(candidate('a:1'), nativeFiveMinuteBars.filter((item) => item.time !== 4200))).toBe(false)
  })

  it('has fully backed decision questions across the four imported markets', () => {
    const historyBySymbol = new Map<string, Candle[] | null>()
    const eligible = replayDecisionCandidates().filter((item) => {
      if (!historyBySymbol.has(item.symbol)) {
        const metadata = snapshotManifest.series[item.symbol as keyof typeof snapshotManifest.series]
        const payload = metadata ? JSON.parse(readFileSync(path.join(process.cwd(), 'public', metadata.file), 'utf8')) : null
        historyBySymbol.set(item.symbol, payload ? parseCompactHistory(payload) : null)
      }
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
    expect(result.initialStopLoss).toBe(95)
    expect(decisionResultPnl(result, 'fixed-risk', 'user')).toBe(60)
  })

  it('repairs legacy fixed-risk results that mistakenly sized from a trailing stop', () => {
    const base = candidate('legacy:26', 'short')
    const item: ReplayDecisionCandidate = {
      ...base,
      symbol: 'XAGUSD',
      interval: '15m',
      trade: {
        ...base.trade,
        tradeNumber: 26,
        entry: { ...base.trade.entry, price: 62.393, stopLoss: 62.776 },
      },
    }
    const legacyAttempt = {
      ...createDecisionAttempt(item),
      stage: 'position-open' as const,
      entryMode: 'signal-extreme' as const,
      orderKind: 'stop' as const,
      pendingEntryPrice: 62.393,
      initialStopLoss: null,
      stopLoss: 62.393677938506215,
      takeProfit: 61.13704526327354,
      fill: { time: 3300, price: 62.393 },
    }
    const correct = buildDecisionResult(item, legacyAttempt, { time: 3600, price: 62.095, reason: 'manual-close' }, [])
    const legacyResult = {
      ...correct,
      initialStopLoss: undefined,
      userPnlUsd: 43_956.78918785127,
      userR: 439.5678918785127,
      differenceUsd: 43_892.82051985127,
    }
    const legacySession = {
      ...createDecisionSession([item], 1, 1),
      status: 'completed' as const,
      attempts: [{ ...legacyAttempt, initialStopLoss: undefined, stage: 'post-exit' as const, result: legacyResult }],
      finishedAt: 2,
    }
    const parsed = parseDecisionReplayStore(JSON.stringify({
      version: 1,
      seenTradeKeys: [item.key],
      activeSessionId: null,
      sessions: [legacySession],
    }))
    const repairedAttempt = parsed.sessions[0].attempts[0]
    const repaired = repairedAttempt.result!

    expect(repairedAttempt.initialStopLoss).toBe(62.776)
    expect(repaired.initialStopLoss).toBe(62.776)
    expect(decisionResultR(repaired, 'user')).toBeCloseTo(0.7780678851)
    expect(decisionResultPnl(repaired, 'fixed-risk', 'user')).toBeCloseTo(77.80678851)
    expect(repaired.userPnlUsd).toBeCloseTo(77.80678851)
    expect(repaired.userR).toBeCloseTo(0.7780678851)
  })

  it('uses the average initial stop distance as one shared R for a round', () => {
    const first = candidate('a:1', 'long')
    const second = candidate('b:2', 'short')
    const firstAttempt = {
      ...createDecisionAttempt(first), stage: 'position-open' as const, entryMode: 'signal-extreme' as const,
      orderKind: 'stop' as const, pendingEntryPrice: 101, initialStopLoss: 95, stopLoss: 100, takeProfit: 105,
      fill: { time: 3300, price: 101 },
    }
    const secondAttempt = {
      ...createDecisionAttempt(second), stage: 'position-open' as const, entryMode: 'signal-extreme' as const,
      orderKind: 'stop' as const, pendingEntryPrice: 101, initialStopLoss: 105, stopLoss: 102, takeProfit: 95,
      fill: { time: 3300, price: 101 },
    }
    const firstResult = buildDecisionResult(first, firstAttempt, { time: 3600, price: 103, reason: 'manual-close' }, [])
    const secondResult = buildDecisionResult(second, secondAttempt, { time: 3600, price: 99, reason: 'manual-close' }, [])
    const session = {
      ...createDecisionSession([first, second], 2, 1),
      attempts: [
        { ...firstAttempt, stage: 'post-exit' as const, result: firstResult },
        { ...secondAttempt, stage: 'post-exit' as const, result: secondResult },
      ],
    }
    const stats = decisionSessionUserRStats(session)

    expect(stats.participatedTradeCount).toBe(2)
    expect(stats.measuredTradeCount).toBe(2)
    expect(stats.averageInitialStopDistance).toBe(5)
    expect(stats.totalR).toBeCloseTo(0.8)
    expect(stats.averageR).toBeCloseTo(0.4)
  })

  it('removes overnight commodity questions from previously saved replay sessions', () => {
    const overnightBase = candidate('overnight:1')
    const overnight = {
      ...overnightBase,
      trade: {
        ...overnightBase.trade,
        entry: { ...overnightBase.trade.entry, time: 57_300 },
        exit: { ...overnightBase.trade.exit, time: 57_900 },
      },
    }
    const kept = candidate('kept:1')
    const session = {
      ...createDecisionSession([overnight, kept], 2, 1000),
      id: 'overnight-session',
      currentIndex: 1,
      attempts: [createDecisionAttempt(overnight), createDecisionAttempt(kept)],
    }

    const parsed = parseDecisionReplayStore(JSON.stringify(storeWithSessions(session)))

    expect(parsed.sessions).toHaveLength(1)
    expect(parsed.sessions[0].candidates.map((item) => item.key)).toEqual(['kept:1'])
    expect(parsed.sessions[0].attempts.map((item) => item.candidateKey)).toEqual(['kept:1'])
    expect(parsed.seenTradeKeys).toEqual(['kept:1'])
  })

  it('advances pending orders and finalizes comparable results without future data', () => {
    const item = candidate('a:1')
    const attempt = { ...createDecisionAttempt(item), stage: 'order-pending' as const, entryMode: 'signal-extreme' as const, orderKind: 'stop' as const, pendingEntryPrice: 100, stopLossMode: 'touch' as const, stopLoss: 95, takeProfit: 105 }
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

  it('cancels a pending order and advances one candle without completing the exercise', () => {
    const item = candidate('a:1')
    const pending = {
      ...createDecisionAttempt(item),
      stage: 'order-pending' as const,
      entryMode: 'free-price' as const,
      orderKind: 'limit' as const,
      pendingEntryPrice: 90,
      initialStopLoss: 85,
      stopLoss: 85,
      takeProfit: 95,
    }
    const canceled = cancelPendingOrderAndAdvance(pending, bar(3600, 101, 102, 100, 101.5))
    expect(canceled).toMatchObject({
      cursorTime: 3600,
      stage: 'entry-decision',
      entryMode: null,
      orderKind: null,
      pendingEntryPrice: null,
      initialStopLoss: null,
      stopLossMode: 'close',
      stopLoss: null,
      takeProfit: null,
      fill: null,
      result: null,
    })
    expect(canceled.candidateKey).toBe(pending.candidateKey)
  })

  it('maps numeric shortcuts only in stages where they are valid', () => {
    expect(decisionShortcutAction('entry-decision', '1')).toBe('advance')
    expect(decisionShortcutAction('entry-decision', '2')).toBe('signal-extreme')
    expect(decisionShortcutAction('entry-decision', '3')).toBe('free-price')
    expect(decisionShortcutAction('entry-decision', '4')).toBe('skip')
    expect(decisionShortcutAction('order-pending', '2')).toBe('cancel-pending')
    expect(decisionShortcutAction('order-pending', '4')).toBeNull()
    expect(decisionShortcutAction('position-open', '2')).toBe('manual-close')
    expect(decisionShortcutAction('post-exit', '1')).toBe('advance')
    expect(decisionShortcutAction('post-exit', '4')).toBe('next-trade')
    expect(decisionShortcutAction('post-exit', '5')).toBe('restart-trade')
    expect(decisionShortcutAction('post-exit', '2')).toBeNull()
    expect(decisionShortcutAction('position-open', '5')).toBeNull()
    expect(decisionShortcutAction('risk-setup', '1')).toBe('confirm-risk')
    expect(decisionShortcutAction('risk-setup', '2')).toBe('cancel-setup')
    expect(decisionShortcutAction('entry-decision', '1', 'day-sequence')).toBe('advance')
    expect(decisionShortcutAction('entry-decision', '2', 'day-sequence')).toBe('open-long')
    expect(decisionShortcutAction('entry-decision', '3', 'day-sequence')).toBe('open-short')
    expect(decisionShortcutAction('entry-decision', '4', 'day-sequence')).toBeNull()
  })

  it('persists and calculates a day-sequence short independently of the long system candidate', () => {
    const item = candidate('day-side:1', 'long')
    const attempt = {
      ...createDecisionAttempt(item, 3900),
      userSide: 'short' as const,
      stage: 'position-open' as const,
      entryMode: 'market-close' as const,
      pendingEntryPrice: 100,
      initialStopLoss: 105,
      stopLoss: 105,
      takeProfit: 95,
      fill: { time: 3900, price: 100 },
    }
    expect(decisionAttemptSide(item, attempt)).toBe('short')
    expect(decisionAttemptSide(item, createDecisionAttempt(item))).toBe('long')

    const evaluation = advanceDecisionAttempt(item, attempt, { time: item.trade.exit.time, open: 100, high: 102, low: 98, close: 99, volume: 1 })
    expect(evaluation.exit).toBeNull()
    const result = buildDecisionResult(item, evaluation.attempt, { time: 4500, price: 95, reason: 'manual-close' }, [])
    expect(result).toMatchObject({ userSide: 'short', entryMode: 'market-close', userPnlUsd: 100, userR: 1 })
    expect(decisionResultSide(result)).toBe('short')

    const session = createDecisionSession([item], 1, 123, ['fixed-risk'], { practiceMode: 'day-sequence' })
    session.attempts = [{ ...evaluation.attempt, stage: 'complete', result }]
    const parsed = parseDecisionReplayStore(serializeDecisionReplayStore({ version: 1, seenTradeKeys: [item.key], activeSessionId: null, sessions: [session] }))
    expect(parsed.sessions[0].attempts[0]).toMatchObject({ userSide: 'short', result: { userSide: 'short', userPnlUsd: 100 } })
  })

  it('navigates backward through completed exercises and only returns forward to the reached active exercise', () => {
    const candidates = [candidate('nav:1'), candidate('nav:2'), candidate('nav:3'), candidate('nav:4')]
    const completedAttempts = candidates.slice(0, 3).map((item) => {
      const attempt = createDecisionAttempt(item)
      return {
        ...attempt,
        stage: 'complete' as const,
        result: buildDecisionResult(item, attempt, { time: attempt.cursorTime, price: item.trade.entry.price, reason: 'skipped' }, []),
      }
    })
    const active = {
      ...createDecisionSession(candidates, candidates.length, 1000),
      currentIndex: 3,
      attempts: [...completedAttempts, createDecisionAttempt(candidates[3])],
    }

    const previous = adjacentDecisionExerciseTarget(active, null, -1)
    expect(previous).toMatchObject({ kind: 'review', result: { candidateKey: 'nav:3' } })
    expect(adjacentDecisionExerciseTarget(active, 'nav:3', -1)).toMatchObject({ kind: 'review', result: { candidateKey: 'nav:2' } })
    expect(adjacentDecisionExerciseTarget(active, 'nav:2', 1)).toMatchObject({ kind: 'review', result: { candidateKey: 'nav:3' } })
    expect(adjacentDecisionExerciseTarget(active, 'nav:3', 1)).toEqual({ kind: 'active' })
    expect(adjacentDecisionExerciseTarget(active, null, 1)).toBeNull()
    expect(adjacentDecisionExerciseTarget(active, 'nav:1', -1)).toBeNull()
  })

  it('does not navigate past the latest result of a completed exercise session', () => {
    const candidates = [candidate('done:1'), candidate('done:2'), candidate('done:3')]
    const attempts = candidates.map((item) => {
      const attempt = createDecisionAttempt(item)
      return {
        ...attempt,
        stage: 'complete' as const,
        result: buildDecisionResult(item, attempt, { time: attempt.cursorTime, price: item.trade.entry.price, reason: 'skipped' }, []),
      }
    })
    const completed = {
      ...createDecisionSession(candidates, candidates.length, 1000),
      currentIndex: 2,
      attempts,
      status: 'completed' as const,
      finishedAt: 2000,
    }

    expect(adjacentDecisionExerciseTarget(completed, null, -1)).toMatchObject({ kind: 'review', result: { candidateKey: 'done:2' } })
    expect(adjacentDecisionExerciseTarget(completed, 'done:2', 1)).toMatchObject({ kind: 'review', result: { candidateKey: 'done:3' } })
    expect(adjacentDecisionExerciseTarget(completed, 'done:3', 1)).toBeNull()
    expect(adjacentDecisionExerciseTarget(completed, null, 1)).toBeNull()
  })

  it('rejects malformed persisted data', () => {
    expect(parseDecisionReplayStore('{bad json')).toMatchObject({ sessions: [], seenTradeKeys: [] })
  })

  it('round-trips compact storage without duplicating result candidates or drawing snapshots', () => {
    const item = candidate('compact:1')
    const attempt = createDecisionAttempt(item)
    const completed = {
      ...attempt,
      stage: 'complete' as const,
      result: buildDecisionResult(item, attempt, { time: 3600, price: 103, reason: 'skipped' }, []),
    }
    const session = {
      ...createDecisionSession([item], 1, 1000),
      attempts: [completed],
      status: 'completed' as const,
      finishedAt: 2000,
    }

    const normalizedStore = parseDecisionReplayStore(JSON.stringify(storeWithSessions(session)))
    const serialized = serializeDecisionReplayStore(normalizedStore)
    const raw = JSON.parse(serialized)
    expect(raw.storageFormat).toBe('compact-v1')
    expect(raw.candidateCatalog).toHaveLength(1)
    expect(raw.sessions[0].candidates).toBeUndefined()
    expect(raw.sessions[0].attempts[0].stopLossMode).toBe('close')
    expect(raw.sessions[0].attempts[0].result.candidate).toBeUndefined()
    expect(raw.sessions[0].attempts[0].result.stopLossMode).toBe('close')
    expect(raw.sessions[0].attempts[0].result.drawings).toBeUndefined()
    expect(parseDecisionReplayStore(serialized)).toEqual(normalizedStore)
  })

  it('keeps touch and close modes on both attempts and results through compact storage and merge', () => {
    const touchItem = candidate('mode-compact:1')
    const closeItem = candidate('mode-compact:2')
    const makeCompleted = (item: ReplayDecisionCandidate, mode: 'touch' | 'close') => {
      const attempt = {
        ...createDecisionAttempt(item),
        stage: 'complete' as const,
        stopLossMode: mode,
        result: buildDecisionResult(item, { ...createDecisionAttempt(item), stopLossMode: mode }, { time: 3600, price: 101, reason: 'skipped' }, []),
      }
      return {
        ...createDecisionSession([item], 1, mode === 'touch' ? 1000 : 2000),
        id: `${mode}-mode-session`,
        attempts: [attempt],
        currentIndex: 0,
        status: 'active' as const,
      }
    }
    const touchSession = makeCompleted(touchItem, 'touch')
    const closeSession = makeCompleted(closeItem, 'close')
    const touchStore = parseDecisionReplayStore(JSON.stringify(storeWithSessions(touchSession)))
    const touchRaw = JSON.parse(serializeDecisionReplayStore(touchStore))
    expect(touchRaw.sessions[0].attempts[0].stopLossMode).toBe('touch')
    expect(touchRaw.sessions[0].attempts[0].result.stopLossMode).toBe('touch')
    expect(parseDecisionReplayStore(JSON.stringify(touchRaw)).sessions[0].attempts[0].stopLossMode).toBe('touch')

    const merged = mergeDecisionReplayStores(touchStore, parseDecisionReplayStore(JSON.stringify(storeWithSessions(closeSession))))
    expect(merged.sessions).toHaveLength(2)
    expect(merged.sessions.find((session) => session.id === touchSession.id)?.attempts[0].stopLossMode).toBe('touch')
    expect(merged.sessions.find((session) => session.id === closeSession.id)?.attempts[0].result?.stopLossMode).toBe('close')
  })

  it('treats a missing legacy mode as touch without changing the parsed baseline result', () => {
    const item = candidate('legacy-mode:1')
    const attempt = {
      ...createDecisionAttempt(item),
      stage: 'complete' as const,
      stopLossMode: 'touch' as const,
      result: buildDecisionResult(item, createDecisionAttempt(item), { time: 3600, price: 101, reason: 'skipped' }, []),
    }
    const { stopLossMode: _legacyAttemptMode, ...legacyAttemptBase } = attempt
    const { stopLossMode: _legacyResultMode, ...legacyResult } = attempt.result!
    expect(_legacyAttemptMode).toBe('touch')
    expect(_legacyResultMode).toBe('close')
    const legacyAttempt = { ...legacyAttemptBase, result: legacyResult }
    const legacySession = {
      ...createDecisionSession([item], 1, 1000),
      id: 'legacy-mode-session',
      attempts: [legacyAttempt],
      currentIndex: 0,
      status: 'active' as const,
    }
    const raw = JSON.stringify(storeWithSessions(legacySession))
    const baseline = parseDecisionReplayStore(raw)
    const restored = parseDecisionReplayStore(serializeDecisionReplayStore(baseline))
    expect(decisionStopLossMode(baseline.sessions[0].attempts[0].stopLossMode)).toBe('touch')
    expect(decisionStopLossMode(baseline.sessions[0].attempts[0].result?.stopLossMode)).toBe('touch')
    expect(restored.sessions[0].attempts[0].result).toEqual(baseline.sessions[0].attempts[0].result)
  })

  it('merges missing legacy touch mode with explicit touch, while touch and close remain distinct', () => {
    const item = candidate('mode-merge:1')
    const makeSession = (mode: 'touch' | 'close', omitMode = false) => {
      const seed = createDecisionAttempt(item)
      const result = buildDecisionResult(item, { ...seed, stopLossMode: mode }, { time: 3600, price: 101, reason: 'skipped' }, [])
      const completeAttempt = { ...seed, stage: 'complete' as const, stopLossMode: mode, result }
      const attempt = omitMode
        ? (() => {
            const { stopLossMode: _attemptMode, ...withoutAttemptMode } = completeAttempt
            const { stopLossMode: _resultMode, ...withoutResultMode } = result
            expect(_attemptMode).toBe(mode)
            expect(_resultMode).toBe(mode)
            return { ...withoutAttemptMode, result: withoutResultMode }
          })()
        : completeAttempt
      return {
        ...createDecisionSession([item], 1, mode === 'touch' ? 1000 : 2000),
        id: 'mode-merge-session',
        attempts: [attempt],
        currentIndex: 1,
        status: 'completed' as const,
        finishedAt: 3000,
      }
    }
    const legacyTouch = parseDecisionReplayStore(JSON.stringify(storeWithSessions(makeSession('touch', true))))
    const explicitTouch = parseDecisionReplayStore(JSON.stringify(storeWithSessions(makeSession('touch'))))
    const compatible = mergeDecisionReplayStores(legacyTouch, explicitTouch)
    expect(compatible.sessions).toHaveLength(1)
    expect(decisionStopLossMode(compatible.sessions[0].attempts[0].stopLossMode)).toBe('touch')
    expect(decisionStopLossMode(compatible.sessions[0].attempts[0].result?.stopLossMode)).toBe('touch')

    const explicitClose = parseDecisionReplayStore(JSON.stringify(storeWithSessions(makeSession('close'))))
    const distinct = mergeDecisionReplayStores(explicitTouch, explicitClose)
    expect(distinct.sessions).toHaveLength(2)
    expect(new Set(distinct.sessions.map((session) => decisionStopLossMode(session.attempts[0].result?.stopLossMode)))).toEqual(new Set(['touch', 'close']))
  })

  it('deduplicates one persisted exercise that was saved under two session ids', () => {
    const item = candidate('duplicate:1')
    const original = { ...createDecisionSession([item], 1, 1000), id: 'duplicate-original' }
    const copy = { ...original, id: 'duplicate-copy' }

    const parsed = parseDecisionReplayStore(JSON.stringify({
      ...storeWithSessions(original, copy),
      activeSessionId: copy.id,
    }))

    expect(parsed.sessions).toHaveLength(1)
    expect(parsed.sessions[0].id).toBe(original.id)
    expect(parsed.activeSessionId).toBe(original.id)
  })

  it('deduplicates identical completed exercises when workspace histories are merged', () => {
    const item = candidate('duplicate-completed:1')
    const base = createDecisionSession([item], 1, 1000)
    const attempt = {
      ...base.attempts[0],
      stage: 'complete' as const,
      result: buildDecisionResult(item, base.attempts[0], { time: 3600, price: item.trade.entry.price, reason: 'skipped' }, []),
    }
    const original = {
      ...base,
      id: 'duplicate-completed-original',
      attempts: [attempt],
      currentIndex: 1,
      status: 'completed' as const,
      finishedAt: 4000,
    }
    const copy = { ...original, id: 'duplicate-completed-copy' }

    const merged = mergeDecisionReplayStores(storeWithSessions(original), storeWithSessions(copy))

    expect(merged.sessions).toHaveLength(1)
    expect(merged.sessions[0].id).toBe(original.id)
    expect(merged.sessions[0].attempts[0].result?.choice).toBe('skipped')
  })

  it('keeps one occurrence when a completed practice trade appears in separate sessions', () => {
    const item = candidate('duplicate-trade:1')
    const makeCompleted = (id: string, startedAt: number, price: number) => {
      const base = { ...createDecisionSession([item], 1, startedAt), id }
      const attempt = {
        ...base.attempts[0],
        stage: 'complete' as const,
        result: buildDecisionResult(item, base.attempts[0], { time: startedAt + 1, price, reason: 'skipped' }, []),
      }
      return { ...base, attempts: [attempt], currentIndex: 1, status: 'completed' as const, finishedAt: startedAt + 2 }
    }

    const parsed = parseDecisionReplayStore(JSON.stringify({
      version: 1,
      seenTradeKeys: [],
      activeSessionId: null,
      sessions: [makeCompleted('duplicate-later', 2000, 102), makeCompleted('duplicate-earlier', 1000, 101)],
    }))

    expect(parsed.sessions).toHaveLength(1)
    expect(parsed.sessions[0].id).toBe('duplicate-earlier')
    expect(parsed.sessions[0].attempts).toHaveLength(1)
    expect(parsed.sessions[0].attempts[0].result?.userExit.price).toBe(101)
    expect(parsed.seenTradeKeys).toEqual(['duplicate-trade:1'])
  })

  it('keeps the same completed trade once in each practice mode', () => {
    const item = candidate('cross-mode-trade:1')
    const makeCompleted = (id: string, startedAt: number, practiceMode: 'random-count' | 'day-sequence') => {
      const base = {
        ...createDecisionSession([item], 1, startedAt, ['fixed-notional'], { practiceMode }),
        id,
      }
      const attempt = {
        ...base.attempts[0],
        stage: 'complete' as const,
        result: buildDecisionResult(item, base.attempts[0], { time: startedAt + 1, price: 101, reason: 'skipped' }, []),
      }
      return { ...base, attempts: [attempt], currentIndex: 1, status: 'completed' as const, finishedAt: startedAt + 2 }
    }

    const parsed = parseDecisionReplayStore(JSON.stringify({
      version: 1,
      seenTradeKeys: ['cross-mode-trade:1'],
      activeSessionId: null,
      sessions: [
        makeCompleted('custom-mode-copy', 1000, 'random-count'),
        makeCompleted('day-sequence-copy', 2000, 'day-sequence'),
      ],
    }))

    expect(parsed.sessions).toHaveLength(2)
    expect(parsed.sessions.map((session) => session.practiceMode).sort()).toEqual(['day-sequence', 'random-count'])
    expect(parsed.sessions.every((session) => session.candidates[0].key === 'cross-mode-trade:1')).toBe(true)
    expect(parsed.seenTradeKeys).toEqual(['cross-mode-trade:1'])
  })

  it('keeps one completed copy when a legacy import regenerated its candidate key', () => {
    const originalCandidate = candidate('duplicate-regenerated:1')
    const regeneratedCandidate = { ...originalCandidate, key: 'duplicate-regenerated-copy:1' }
    const completed = (item: ReplayDecisionCandidate, id: string) => {
      const base = createDecisionSession([item], 1, 1000)
      const attempt = {
        ...base.attempts[0],
        stage: 'complete' as const,
        result: buildDecisionResult(item, base.attempts[0], { time: 3600, price: item.trade.entry.price, reason: 'skipped' }, []),
      }
      return {
        ...base,
        id,
        attempts: [attempt],
        currentIndex: 1,
        status: 'completed' as const,
        finishedAt: 4000,
      }
    }

    const merged = mergeDecisionReplayStores(
      storeWithSessions(completed(originalCandidate, 'regenerated-original')),
      storeWithSessions(completed(regeneratedCandidate, 'regenerated-copy')),
    )

    expect(merged.sessions).toHaveLength(1)
    expect(merged.sessions[0].candidates).toHaveLength(1)
    expect(merged.sessions[0].attempts).toHaveLength(1)
  })

  it('does not throw or blank the app when browser storage rejects a write', () => {
    const storage = { setItem: () => { throw new DOMException('quota exceeded', 'QuotaExceededError') } }
    expect(saveDecisionReplayStore(storeWithSessions(), storage)).toBe(false)
  })

  it('persists a canonical interactive snapshot without rereading and merging the full history', () => {
    const session = createDecisionSession([candidate('fast-save:1')], 1, 1000)
    let value = ''
    let reads = 0
    const storage = {
      getItem: () => { reads += 1; return value },
      setItem: (_key: string, next: string) => { value = next },
    }

    expect(saveDecisionReplayStoreSnapshot(storeWithSessions(session), storage)).toBe(true)
    expect(reads).toBe(0)
    expect(parseDecisionReplayStore(value)).toMatchObject({ activeSessionId: session.id })
  })

  it('does not let an older tab overwrite sessions already present in browser storage', () => {
    const storedSession = createDecisionSession([candidate('stored-newer:1')], 1, 2000)
    const staleTabSession = createDecisionSession([candidate('stale-tab:1')], 1, 1000)
    let value = serializeDecisionReplayStore(storeWithSessions(storedSession))
    const storage = {
      getItem: () => value,
      setItem: (_key: string, next: string) => { value = next },
    }

    const persisted = persistDecisionReplayStoreAdditively(storeWithSessions(staleTabSession), storage)
    const restored = parseDecisionReplayStore(value)

    expect(persisted.saved).toBe(true)
    expect(restored.sessions.map((session) => session.candidates[0].key).sort()).toEqual(['stale-tab:1', 'stored-newer:1'])
  })

  it('keeps a newly-created session active when additive persistence reads an older snapshot', () => {
    const startedSession = createDecisionSession([candidate('just-started:1')], 1, 3000)
    let value = serializeDecisionReplayStore(emptyDecisionReplayStore())
    const storage = {
      getItem: () => value,
      setItem: (_key: string, next: string) => { value = next },
    }

    const persisted = persistDecisionReplayStoreAdditively(storeWithSessions(startedSession), storage)
    const restored = parseDecisionReplayStore(value)

    expect(persisted.store.activeSessionId).toBe(startedSession.id)
    expect(restored.activeSessionId).toBe(startedSession.id)
    expect(restored.sessions.find((session) => session.id === startedSession.id)?.status).toBe('active')
  })

  it('retains another tab active session when the current tab has none', () => {
    const storedSession = createDecisionSession([candidate('other-tab-active:1')], 1, 3000)
    let value = serializeDecisionReplayStore(storeWithSessions(storedSession))
    const storage = {
      getItem: () => value,
      setItem: (_key: string, next: string) => { value = next },
    }

    const persisted = persistDecisionReplayStoreAdditively(emptyDecisionReplayStore(), storage)

    expect(persisted.store.activeSessionId).toBe(storedSession.id)
    expect(parseDecisionReplayStore(value).activeSessionId).toBe(storedSession.id)
  })

  it('repairs an active session whose current candidate lost its attempt during sync', () => {
    const candidates = [candidate('repair:1'), candidate('repair:2')]
    const firstAttempt = createDecisionAttempt(candidates[0])
    const completedFirst = {
      ...firstAttempt,
      stage: 'complete' as const,
      result: buildDecisionResult(candidates[0], firstAttempt, { time: 1001, price: candidates[0].trade.entry.price, reason: 'skipped' }, []),
    }
    const broken = {
      ...createDecisionSession(candidates, 2, 1000),
      id: 'repair',
      currentIndex: 1,
      attempts: [completedFirst],
    }

    const repaired = parseDecisionReplayStore(JSON.stringify(storeWithSessions(broken)))
    const session = repaired.sessions[0]
    const currentAttempt = session.attempts.find((attempt) => attempt.candidateKey === candidates[1].key)

    expect(session.currentIndex).toBe(1)
    expect(currentAttempt).toMatchObject({ candidateKey: candidates[1].key, stage: 'entry-decision', result: null })
  })

  it('does not advance a post-exit exercise during a background sync merge', () => {
    const candidates = [candidate('post-exit-sync:1'), candidate('post-exit-sync:2')]
    const base = { ...createDecisionSession(candidates, 2, 1000), id: 'post-exit-sync' }
    const exitedAttempt = {
      ...base.attempts[0],
      stage: 'post-exit' as const,
      result: buildDecisionResult(candidates[0], base.attempts[0], {
        time: 1001,
        price: candidates[0].trade.entry.price,
        reason: 'manual-close',
      }, []),
    }
    const local = { ...base, attempts: [exitedAttempt], currentIndex: 0, updatedAt: 3000 }
    const remote = { ...base, updatedAt: 2000 }

    const merged = mergeDecisionReplayStores(storeWithSessions(local), storeWithSessions(remote))
    const session = merged.sessions.find((item) => item.id === base.id)!

    expect(merged.activeSessionId).toBe(base.id)
    expect(session).toMatchObject({ status: 'active', currentIndex: 0 })
    expect(session.attempts[0]).toMatchObject({ stage: 'post-exit', result: { choice: 'skipped' } })
    expect(session.attempts.some((attempt) => attempt.candidateKey === candidates[1].key)).toBe(false)
  })

  it('repairs an active exercise that an older additive save advanced past post-exit', () => {
    const candidates = [candidate('post-exit-repair:1'), candidate('post-exit-repair:2')]
    const base = { ...createDecisionSession(candidates, 2, 1000), id: 'post-exit-repair' }
    const exitedAttempt = {
      ...base.attempts[0],
      stage: 'post-exit' as const,
      result: buildDecisionResult(candidates[0], base.attempts[0], {
        time: 1001,
        price: candidates[0].trade.entry.price,
        reason: 'manual-close',
      }, []),
    }
    const prematurelyCreatedNext = createDecisionAttempt(candidates[1])
    const broken = {
      ...base,
      attempts: [exitedAttempt, prematurelyCreatedNext],
      currentIndex: 1,
      updatedAt: 3000,
    }

    const repaired = parseDecisionReplayStore(JSON.stringify(storeWithSessions(broken)))
    const session = repaired.sessions.find((item) => item.id === base.id)!

    expect(repaired.activeSessionId).toBe(base.id)
    expect(session.currentIndex).toBe(0)
    expect(session.attempts).toHaveLength(2)
    expect(session.attempts[0]).toMatchObject({ stage: 'post-exit', result: { choice: 'skipped' } })
    expect(session.attempts[1]).toMatchObject({ stage: 'entry-decision', result: null })
  })

  it('restarts only the current post-exit exercise and overrides the stale saved result', () => {
    const candidates = [candidate('restart:1'), candidate('restart:2')]
    const base = { ...createDecisionSession(candidates, 2, 1000), id: 'restart-session' }
    const exitedAttempt = {
      ...base.attempts[0],
      stage: 'post-exit' as const,
      cursorTime: 4200,
      stopLossMode: 'touch' as const,
      result: buildDecisionResult(candidates[0], { ...base.attempts[0], stopLossMode: 'touch' }, {
        time: 4200,
        price: candidates[0].trade.entry.price,
        reason: 'manual-close',
      }, []),
    }
    const stale = { ...base, attempts: [exitedAttempt], updatedAt: 2000 }
    const restarted = restartPostExitDecisionAttempt(stale, candidates[0].key, 3000)

    expect(restarted).toMatchObject({ currentIndex: 0, status: 'active', correctionRevision: 3000, updatedAt: 3000 })
    expect(restarted.attempts[0]).toMatchObject({
      candidateKey: candidates[0].key,
      stage: 'entry-decision',
      cursorTime: candidates[0].trade.entry.signalTime,
      stopLossMode: 'close',
      result: null,
      fill: null,
      drawings: [],
    })
    const merged = mergeDecisionReplayStores(storeWithSessions(restarted), storeWithSessions(stale))
    expect(merged.sessions[0].attempts[0]).toMatchObject({ stage: 'entry-decision', result: null })
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

  it('keeps an explicit newer correction when sync contains stale deeper progress', () => {
    const candidates = [candidate('corrected:1'), candidate('corrected:2')]
    const base = { ...createDecisionSession(candidates, 2, 1000), id: 'corrected-session' }
    const firstAttempt = base.attempts[0]
    const staleAdvanced = {
      ...base,
      currentIndex: 1,
      attempts: [
        { ...firstAttempt, stage: 'complete' as const, result: buildDecisionResult(candidates[0], firstAttempt, { time: 1001, price: 101, reason: 'skipped' }, []) },
        createDecisionAttempt(candidates[1]),
      ],
      updatedAt: 3000,
    }
    const corrected = { ...base, correctionRevision: 4000, updatedAt: 4000 }

    const merged = mergeDecisionReplayStores(storeWithSessions(corrected), storeWithSessions(staleAdvanced))

    expect(merged.sessions[0]).toMatchObject({ id: 'corrected-session', currentIndex: 0, correctionRevision: 4000 })
    expect(merged.sessions[0].attempts).toHaveLength(1)
    expect(merged.sessions[0].attempts[0].result).toBeNull()
  })

  it('starts an independent interactive review without changing the saved result', () => {
    const item = candidate('review:1')
    const sourceAttempt = {
      ...createDecisionAttempt(item),
      stage: 'position-open' as const,
      entryMode: 'signal-extreme' as const,
      orderKind: 'stop' as const,
      pendingEntryPrice: 101,
      initialStopLoss: 95,
      stopLossMode: 'touch' as const,
      stopLoss: 95,
      takeProfit: 107,
      fill: { time: 3300, price: 101 },
    }
    const sourceResult = buildDecisionResult(item, sourceAttempt, { time: 3900, price: 102, reason: 'manual-close' }, [])
    const source = {
      ...createDecisionSession([item], 1, 1000, ['fixed-notional']),
      id: 'source-session',
      attempts: [{ ...sourceAttempt, stage: 'complete' as const, result: sourceResult }],
      currentIndex: 0,
      status: 'completed' as const,
      finishedAt: 2000,
    }

    const review = createDecisionReviewSession(source, sourceResult, 3000)
    expect(review.origin).toBe('review')
    expect(review.sourceSessionId).toBe('source-session')
    expect(review.sourceCandidateKey).toBe(sourceResult.candidateKey)
    expect(review.positionSizingModes).toEqual(['fixed-notional'])
    expect(review.attempts[0]).toMatchObject({ candidateKey: item.key, stage: 'entry-decision', cursorTime: item.trade.entry.signalTime, stopLossMode: 'close', result: null })
    expect(sourceResult.stopLossMode).toBe('touch')
    expect(source.attempts[0].result).toEqual(sourceResult)
    expect(source.status).toBe('completed')
  })

  it('keeps an imported active session in history without activating it locally', () => {
    const importedActive = { ...createDecisionSession([candidate('imported-active:1')], 1, 1200), id: 'imported-active' }
    const merged = mergeDecisionReplayStores(
      { version: 1, seenTradeKeys: [], activeSessionId: null, sessions: [] },
      { version: 1, seenTradeKeys: ['imported-active:1'], activeSessionId: importedActive.id, sessions: [importedActive] },
    )

    expect(merged.activeSessionId).toBeNull()
    expect(merged.sessions).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'imported-active', status: 'active' })]))
  })

  it('keeps the local active session when the imported store also points at an active session', () => {
    const localActive = { ...createDecisionSession([candidate('local-active:1')], 1, 1000), id: 'local-active' }
    const importedActive = { ...createDecisionSession([candidate('imported-active:2')], 1, 2000), id: 'imported-active' }
    const merged = mergeDecisionReplayStores(
      { version: 1, seenTradeKeys: ['local-active:1'], activeSessionId: localActive.id, sessions: [localActive] },
      { version: 1, seenTradeKeys: ['imported-active:2'], activeSessionId: importedActive.id, sessions: [importedActive] },
    )

    expect(merged.activeSessionId).toBe('local-active')
    expect(merged.sessions.map((session) => session.id)).toEqual(['imported-active', 'local-active'])
  })

  it('does not change an active session timestamp when its loaded drawings are unchanged', () => {
    const item = candidate('drawings:1')
    const session = createDecisionSession([item], 1, 1000)
    expect(updateDecisionSessionDrawings(session, item.key, [], 2000)).toBe(session)
    expect(updateDecisionSessionDrawings(session, 'missing', [], 2000)).toBe(session)
  })

  it('unions non-conflicting attempts when the same session continued on two computers', () => {
    const candidates = [candidate('shared:1'), candidate('shared:2')]
    const base = { ...createDecisionSession(candidates, 2, 1000), id: 'shared' }
    const secondBaseAttempt = createDecisionAttempt(candidates[1])
    const firstAttempt = {
      ...base.attempts[0], stage: 'complete' as const,
      result: buildDecisionResult(candidates[0], base.attempts[0], { time: 1001, price: candidates[0].trade.entry.price, reason: 'skipped' }, []),
    }
    const secondAttempt = {
      ...secondBaseAttempt, stage: 'complete' as const,
      result: buildDecisionResult(candidates[1], secondBaseAttempt, { time: 1002, price: candidates[1].trade.entry.price, reason: 'skipped' }, []),
    }
    const left = { ...base, attempts: [firstAttempt], currentIndex: 1, updatedAt: 2000 }
    const right = { ...base, attempts: [base.attempts[0], secondAttempt], currentIndex: 1, updatedAt: 3000 }

    const merged = mergeDecisionReplayStores(storeWithSessions(left), storeWithSessions(right))

    expect(merged.sessions).toHaveLength(1)
    expect(merged.sessions[0].attempts.filter((attempt) => attempt.result)).toHaveLength(2)
    expect(merged.sessions[0]).toMatchObject({ status: 'completed', currentIndex: 2 })
  })

  it('preserves two different answers to the same question in a deterministic branch session', () => {
    const item = candidate('shared:conflict')
    const base = { ...createDecisionSession([item], 1, 1000), id: 'shared-conflict' }
    const skipped = {
      ...base.attempts[0], stage: 'complete' as const,
      result: buildDecisionResult(item, base.attempts[0], { time: 1001, price: item.trade.entry.price, reason: 'skipped' }, []),
    }
    const stopped = {
      ...base.attempts[0], stage: 'complete' as const,
      result: { ...skipped.result!, choice: 'traded' as const, userPnlUsd: -100 },
    }
    const left = { ...base, attempts: [skipped], currentIndex: 1, status: 'completed' as const, updatedAt: 2000, finishedAt: 2000 }
    const right = { ...base, attempts: [stopped], currentIndex: 1, status: 'completed' as const, updatedAt: 3000, finishedAt: 3000 }

    const firstMerge = mergeDecisionReplayStores(storeWithSessions(left), storeWithSessions(right))
    const secondMerge = mergeDecisionReplayStores(firstMerge, storeWithSessions(right))

    expect(firstMerge.sessions).toHaveLength(2)
    expect(firstMerge.sessions.flatMap((session) => session.attempts).filter((attempt) => attempt.result)).toHaveLength(2)
    expect(firstMerge.sessions.some((session) => session.id.startsWith('shared-conflict-sync-'))).toBe(true)
    expect(secondMerge.sessions.map((session) => session.id)).toEqual(firstMerge.sessions.map((session) => session.id))
  })

  it('collapses identical legacy sync branches and never nests their ids', () => {
    const item = candidate('shared:legacy-branch')
    const base = { ...createDecisionSession([item], 1, 1000), id: 'shared-legacy-branch' }
    const skipped = {
      ...base.attempts[0], stage: 'complete' as const,
      result: buildDecisionResult(item, base.attempts[0], { time: 1001, price: item.trade.entry.price, reason: 'skipped' }, []),
    }
    const traded = {
      ...base.attempts[0], stage: 'complete' as const,
      result: { ...skipped.result!, choice: 'traded' as const, userPnlUsd: 25 },
    }
    const left = { ...base, attempts: [skipped], currentIndex: 1, status: 'completed' as const, updatedAt: 2000, finishedAt: 2000 }
    const right = { ...base, attempts: [traded], currentIndex: 1, status: 'completed' as const, updatedAt: 3000, finishedAt: 3000 }
    const firstMerge = mergeDecisionReplayStores(storeWithSessions(left), storeWithSessions(right))
    const branch = firstMerge.sessions.find((session) => session.id.includes('-sync-'))!
    const primary = firstMerge.sessions.find((session) => !session.id.includes('-sync-'))!
    const legacyCopies = [
      { ...branch, id: `${branch.id}-sync-old-a` },
      { ...branch, id: `${branch.id}-sync-old-a-sync-old-b` },
      { ...primary, id: `${primary.id}-sync-old-primary-copy` },
      {
        ...primary,
        id: `${primary.id}-sync-old-primary-subset`,
        requestedCount: 1,
        candidates: primary.candidates.slice(0, 1),
        attempts: primary.attempts.slice(0, 1),
        currentIndex: 1,
      },
    ]

    const normalized = mergeDecisionReplayStores(
      { ...firstMerge, sessions: [...firstMerge.sessions, ...legacyCopies] },
      emptyDecisionReplayStore(),
    )
    const repeated = mergeDecisionReplayStores(normalized, normalized)
    const branches = normalized.sessions.filter((session) => session.id.includes('-sync-'))

    expect(branches).toHaveLength(1)
    expect(branches[0].id.match(/-sync-/g)).toHaveLength(1)
    expect(normalized.sessions.flatMap((session) => session.attempts).filter((attempt) => attempt.result)).toHaveLength(2)
    expect(repeated).toEqual(normalized)
  })

  it('does not merge immutable branches again when legacy and canonical ids collide', () => {
    const item = candidate('shared:branch-id-collision')
    const base = { ...createDecisionSession([item], 1, 1000), id: 'shared-branch-id-collision' }
    const skipped = {
      ...base.attempts[0], stage: 'complete' as const,
      result: buildDecisionResult(item, base.attempts[0], { time: 1001, price: item.trade.entry.price, reason: 'skipped' }, []),
    }
    const firstTrade = {
      ...base.attempts[0], stage: 'complete' as const,
      result: { ...skipped.result!, choice: 'traded' as const, userPnlUsd: 25 },
    }
    const left = { ...base, attempts: [skipped], currentIndex: 1, status: 'completed' as const, updatedAt: 2000, finishedAt: 2000 }
    const right = { ...base, attempts: [firstTrade], currentIndex: 1, status: 'completed' as const, updatedAt: 3000, finishedAt: 3000 }
    const firstMerge = mergeDecisionReplayStores(storeWithSessions(left), storeWithSessions(right))
    const branch = firstMerge.sessions.find((session) => session.id.includes('-sync-'))!
    const collidingLegacyBranch = {
      ...branch,
      attempts: branch.attempts.map((attempt) => ({
        ...attempt,
        result: attempt.result ? { ...attempt.result, userPnlUsd: 50 } : null,
      })),
    }

    const normalized = mergeDecisionReplayStores(
      { ...firstMerge, sessions: [...firstMerge.sessions, collidingLegacyBranch] },
      emptyDecisionReplayStore(),
    )
    const repeated = mergeDecisionReplayStores(normalized, normalized)

    expect(normalized.sessions).toHaveLength(3)
    expect(normalized.sessions.filter((session) => session.id.includes('-sync-'))).toHaveLength(2)
    expect(normalized.sessions.flatMap((session) => session.attempts).filter((attempt) => attempt.result)).toHaveLength(3)
    expect(repeated).toEqual(normalized)
  })
})
