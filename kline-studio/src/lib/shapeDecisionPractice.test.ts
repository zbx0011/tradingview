import { describe, it, expect } from 'vitest'
import { removeShapeQuestion, shapeAiMarkers, shapeAiReview, confirmedShapeQuestionKeys, shapeDecisionCandidates, shapeDecisionHistory, filterShapeCandidates, shapePatternOptions } from './shapeDecisionPractice'
import { createDecisionSession, createDecisionAttempt, advanceDecisionAttempt, decisionResultHasSystemBenchmark, parseDecisionReplayStoreChecked, serializeDecisionReplayStore, emptyDecisionReplayStore, normalizeDecisionReplayStore } from './decisionReplay'

describe('shape cases in the existing custom-count flow', () => {
  it('filters by stable pattern ID and never falls back to all questions for an empty selection', () => {
    expect(filterShapeCandidates([])).toEqual([])
    expect(filterShapeCandidates(['unselected-other-pattern'])).toEqual([])
    expect(filterShapeCandidates(['channel-decay-reversal'])).toHaveLength(12)
    const options = shapePatternOptions([shapeDecisionCandidates[1].key])
    expect(options[0]).toMatchObject({ id: 'channel-decay-reversal', name: '通道衰减反转', total: 12, remaining: 11 })
    expect(filterShapeCandidates(['channel-decay-reversal']).every(c => c.trade.entry.setup.startsWith('通道衰减反转'))).toBe(true)
  })
  it('preserves original cases and supplemental cases and uses frozen per-case history', () => {
    expect(shapeDecisionCandidates).toHaveLength(39)
    for (const c of shapeDecisionCandidates) {
      const bars = shapeDecisionHistory(c)!
      expect(bars[c.trade.entry.signalIdx].time).toBe(c.trade.entry.signalTime)
      expect(bars.at(-1)!.time).toBeLessThan(c.trade.exit.time)
      expect(decisionResultHasSystemBenchmark({candidate:c})).toBe(false)
    }
  })
  it('round-trips the normal practice store without losing case IDs', () => {
    const session = createDecisionSession(shapeDecisionCandidates,22)
    const store = {...emptyDecisionReplayStore(),activeSessionId:session.id,sessions:[session]}
    const restored = parseDecisionReplayStoreChecked(serializeDecisionReplayStore(store))!
    expect(restored.sessions[0].candidates.map(c=>c.shapePracticeId)).toEqual(shapeDecisionCandidates.map(c=>c.shapePracticeId))
    expect(restored.sessions[0].practiceMode).toBe('random-count')
  })
  it('does not automatically exit a shape position at placeholder system prices', () => {
    const c=shapeDecisionCandidates[0]
    const attempt={...createDecisionAttempt(c),stage:'position-open' as const,fill:{time:1,price:100},stopLoss:1,takeProfit:200,stopLossMode:'close' as const,userSide:undefined}
    const candidate={...c,trade:{...c.trade,side:'long' as const,exit:{...c.trade.exit,time:2,price:999}}}
    const r=advanceDecisionAttempt(candidate,attempt,{time:2,open:100,high:102,low:99,close:101,volume:1})
    expect(r.exit).toBeNull()
  })
})


describe('confirmed shape question accounting', () => {
  it('releases legacy batch reservations and counts only confirmed questions', () => {
    const session = createDecisionSession(shapeDecisionCandidates, 22)
    const reserved = { ...emptyDecisionReplayStore(), activeSessionId: session.id,
      seenTradeKeys: shapeDecisionCandidates.map(c => c.key), sessions: [session] }
    expect(normalizeDecisionReplayStore(reserved).seenTradeKeys).toEqual([])
    session.attempts = [{ ...createDecisionAttempt(shapeDecisionCandidates[0]), stage: 'post-exit' }]
    expect(normalizeDecisionReplayStore(reserved).seenTradeKeys).toEqual([])
    session.attempts[0].stage = 'complete'
    const normalized = normalizeDecisionReplayStore(reserved)
    expect(normalized.seenTradeKeys).toEqual([shapeDecisionCandidates[0].key])
    expect(shapePatternOptions(normalized.seenTradeKeys)[0].remaining).toBe(12)
    expect(normalized.sessions[0].candidates).toHaveLength(39)
  })
  it('keeps a newly drawn unfinished shape session and earlier progress', () => {
    const first = { ...createDecisionSession(shapeDecisionCandidates, 22, 100), status: 'stopped' as const }
    const next = createDecisionSession(shapeDecisionCandidates, 22, 200)
    const normalized = normalizeDecisionReplayStore({ ...emptyDecisionReplayStore(),
      activeSessionId: next.id, sessions: [next, first], seenTradeKeys: shapeDecisionCandidates.map(c => c.key) })
    expect(normalized.sessions).toHaveLength(2)
    expect(normalized.activeSessionId).toBe(next.id)
    expect(normalized.seenTradeKeys).toEqual([])
  })
})

it('ignores stale reservation keys when counting an unconfirmed stopped batch', () => {
  const session = { ...createDecisionSession(shapeDecisionCandidates, 22), status: 'stopped' as const }
  expect(shapePatternOptions(confirmedShapeQuestionKeys([session]))[0].remaining).toBe(12)
  session.attempts[0].stage = 'post-exit'
  expect(confirmedShapeQuestionKeys([session])).toEqual([])
})

it('shows every frozen AI shape review only once its signal candle is revealed', () => {
  for (const candidate of shapeDecisionCandidates) {
    expect(['reviewed','visual-review']).toContain(shapeAiReview(candidate)?.verdict)
    const time = candidate.trade.entry.signalTime
    expect(shapeAiMarkers(candidate, time - 1)).toEqual([])
    expect(shapeAiMarkers(candidate, time)).toHaveLength(1)
    expect(shapeAiMarkers(candidate, time)[0].time).toBe(time)
  }
})

it('removes a rejected question without a completed answer and advances to its successor', () => {
 const session=createDecisionSession(shapeDecisionCandidates.slice(1,3),2)
 const removed=removeShapeQuestion(session,session.candidates[0].key)
 expect(removed.candidates).toHaveLength(1)
 expect(removed.currentIndex).toBe(0)
 expect(removed.attempts[0].candidateKey).toBe(session.candidates[1].key)
 expect(confirmedShapeQuestionKeys([removed])).toEqual([])
 expect(shapePatternOptions([], [session.candidates[0].key])[0]).toMatchObject({total:11,remaining:11})
 expect(removeShapeQuestion(removed,removed.candidates[0].key).status).toBe('stopped')
 expect(session.candidates).toHaveLength(2)
})

it('curates the current pool without destroying historical candidates', () => {
 const active=filterShapeCandidates(['channel-decay-reversal'])
 expect(active).toHaveLength(12)
 expect(active.some(c=>c.shapePracticeId==='M14')).toBe(true)
 expect(active.some(c=>c.shapePracticeId==='M49')).toBe(false)
 expect(active.some(c=>c.shapePracticeId==='M03')).toBe(true)
 expect(shapeDecisionCandidates.some(c=>c.shapePracticeId==='M49')).toBe(true)
})

it('excludes failed and uncertain causal events from practice while retaining source records', () => {
 const pool=filterShapeCandidates(['channel-decay-range-confirmed'])
 expect(pool).toHaveLength(1)
 expect(pool[0].shapePracticeId).toContain('-628-bear')
 expect(shapeDecisionCandidates.filter(c=>c.shapePatternId==='channel-decay-range-confirmed')).toHaveLength(9)
})
