import { describe, expect, it } from 'vitest'
import { fullReviewBounds } from './decisionFullReview'
import type { DecisionReplaySession } from './decisionReplay'

describe('complete paper review bounds', () => {
  it('includes the complete trading day even when a paper was stopped early', () => {
    const session = { daySequence: { symbol: 'XAUUSD', interval: '5m', startTime: 1000, endTime: 87400 }, candidates: [], attempts: [] } as unknown as DecisionReplaySession
    expect(fullReviewBounds(session, 'XAUUSD', '5m')).toEqual({ from: 1000, to: 87400 })
  })
  it('includes all system exits and later user exits without changing the paper', () => {
    const session = { candidates: [{ key: 'a', symbol: 'XAUUSD', interval: '5m', trade: { entry: { signalTime: 30000, time: 30300 }, exit: { time: 33000 } } }], attempts: [{ candidateKey: 'a', cursorTime: 33600, result: { userExit: {time: 33900} } }] } as unknown as DecisionReplaySession
    const before = JSON.stringify(session)
    expect(fullReviewBounds(session, 'XAUUSD', '5m')).toEqual({ from: 12000, to: 34200 })
    expect(JSON.stringify(session)).toBe(before)
    expect(fullReviewBounds(session, 'XAGUSD', '5m')).toEqual({from: 0, to: 0})
  })
})
