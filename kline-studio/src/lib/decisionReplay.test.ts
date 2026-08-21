import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import snapshotManifest from '../data/marketSnapshotManifest.json'
import type { ReplayDecisionCandidate } from './replayTradeRegistry'
import { replayDecisionCandidates } from './replayTradeRegistry'
import type { Candle } from './market'
import { parseCompactHistory } from './liveMarket'
import {
  adjacentDecisionExerciseTarget, advanceDecisionAttempt, buildDecisionResult, cancelPendingOrderAndAdvance, candlesKnownAt, compareDecisionHistorySortValues, createDecisionAttempt, createDecisionSession,
  decisionShortcutAction, defaultDecisionLevels, evaluatePositionBar, fillPendingOrder,
  decisionResultPnl, decisionResultR, historyCoversDecisionCandidate, intervalCutoffTime, parseDecisionReplayStore,
  mergeDecisionReplayStores, pnlForDecision, pnlForDecisionMode, rewardRiskRatio, sampleDecisionCandidates,
  updateDecisionSessionDrawings, validDecisionLevels, validOpenPositionLevels, type DecisionReplaySession,
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
    expect(decisionShortcutAction('post-exit', '2')).toBeNull()
    expect(decisionShortcutAction('risk-setup', '1')).toBe('confirm-risk')
    expect(decisionShortcutAction('risk-setup', '2')).toBe('cancel-setup')
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
})
