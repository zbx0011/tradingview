import type { DecisionReplaySession } from './decisionReplay'
import { INTERVALS, type IntervalId, type SymbolId } from './market'

export function fullReviewBounds(session: DecisionReplaySession, symbol: SymbolId, interval: IntervalId) {
  if (session.daySequence?.symbol === symbol && session.daySequence.interval === interval) {
    return { from: session.daySequence.startTime, to: session.daySequence.endTime }
  }
  const candidates = session.candidates.filter(c => c.symbol === symbol && c.interval === interval)
  const keys = new Set(candidates.map(c => c.key))
  const times = candidates.flatMap(c => [c.trade.entry.signalTime, c.trade.entry.time, c.trade.exit.time])
  for (const a of session.attempts) if (keys.has(a.candidateKey)) times.push(a.cursorTime, ...(a.result ? [a.result.userExit.time] : []))
  const seconds = INTERVALS[interval].seconds
  return times.length ? { from: Math.min(...times) - 60 * seconds, to: Math.floor(Math.max(...times) / seconds) * seconds + seconds } : { from: 0, to: 0 }
}
