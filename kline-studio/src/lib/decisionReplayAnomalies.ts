import type { Candle } from './market'
import { createDecisionSession, decisionStopLossMode, type DecisionPositionSizingMode, type DecisionReplaySession, type DecisionTradeResult } from './decisionReplay'

export interface DecisionReplayAnomaly {
  sessionId: string
  result: DecisionTradeResult
  reasons: string[]
}

/** Inspect only this browser's saved history; no personal trade list is bundled with the app. */
export function findDecisionReplayAnomalies(sessions: readonly DecisionReplaySession[], candles: readonly Candle[]): DecisionReplayAnomaly[] {
  if (!candles.length) return []
  const byTime = new Map(candles.map((bar) => [bar.time, bar]))
  const anomalies: DecisionReplayAnomaly[] = []
  for (const session of sessions) {
    if (session.reviewKind === 'stop-anomalies') continue
    for (const attempt of session.attempts) {
      const result = attempt.result
      if (!result || result.candidate.symbol !== 'XAUUSD' || result.candidate.interval !== '5m'
        || result.choice !== 'traded' || !result.userEntry || result.userExit.reason !== 'stop-loss'
        || decisionStopLossMode(result.stopLossMode) !== 'touch') continue
      const reasons: string[] = []
      const bar = byTime.get(result.userExit.time)
      const stop = result.stopLoss
      if (stop === null || !Number.isFinite(stop)) reasons.push('缺少有效止损价')
      else if (!bar) reasons.push('缺少原止损K线')
      else {
        const long = result.candidate.trade.side === 'long'
        if (!(long ? bar.low <= stop : bar.high >= stop)) reasons.push('原止损未被当前OANDA该K触碰')
        const expectedFill = long ? Math.min(bar.open, stop) : Math.max(bar.open, stop)
        if (Math.abs(expectedFill - result.userExit.price) > 1e-8) reasons.push('原止损成交与当前K线不一致')
      }
      if (result.candidate.trade.exit.time < result.userEntry.time) reasons.push('系统在用户开仓前已退出')
      if (!byTime.has(result.candidate.trade.exit.time)) reasons.push('缺少系统平仓K线')
      if (reasons.length) anomalies.push({ sessionId: session.id, result, reasons })
    }
  }
  return anomalies
}

/** A separate, fresh review batch. Never clear seen keys or mutate the source results. */
export function createDecisionAnomalyReviewSession(
  anomalies: readonly DecisionReplayAnomaly[],
  positionSizingModes: readonly DecisionPositionSizingMode[],
  now = Date.now(),
): DecisionReplaySession {
  const candidates = [...new Map(anomalies.map(({ result }) => [result.candidate.key, result.candidate])).values()]
  const session = createDecisionSession(candidates, candidates.length, now, positionSizingModes, { origin: 'review' })
  return {
    ...session,
    reviewKind: 'stop-anomalies',
    reviewSourceRecords: anomalies.map(({ sessionId, result }) => ({ sessionId, candidateKey: result.candidateKey })),
  }
}
