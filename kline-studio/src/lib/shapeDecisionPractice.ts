import { validateShapeSequence } from './shapeCausalSequence'
import supplemental from '../../public/data/shape-practice/xauusd-5m-supplemental.json'
import curation from '../data/shape-curation.json'
import reviews from '../data/shape-ai-reviews.json'
import type { SeriesMarker, UTCTimestamp } from 'lightweight-charts'
import raw from '../../public/data/shape-practice/xauusd-5m-strong22.json'
import completed from '../../public/data/shape-practice/causal-range-confirmations.json'
import annotationReviews from '../data/shape-annotation-reviews.json'
import type { ReplayDecisionCandidate } from './replayTradeRegistry'
import { createDecisionAttempt, type DecisionReplaySession, type DecisionReplayStore } from './decisionReplay'
import type { Candle } from './market'

const allShapeQuestions = [...raw.questions, ...supplemental.questions, ...completed.questions]
const causalEventIds = new Set(completed.questions.map(q => q.id))
export const excludedShapeIds = new Set<string>(curation.excluded_ids)
const reviewedShapeIds = new Set(annotationReviews.reviews.filter(r => {
  const question = allShapeQuestions.find(q => q.id === r.id)
  return r.verdict === 'match' && question?.startIndex === r.endIndex && r.phases.length === 3
    && r.phases.every((p, i) => p.kind === ['narrow', 'wide', 'range'][i]
      && Number.isInteger(p.startIndex) && Number.isInteger(p.endIndex)
      && p.startIndex >= 0 && p.startIndex < p.endIndex && p.endIndex <= r.endIndex
      && (i === 0 || p.startIndex >= r.phases[i - 1].endIndex))
}).map(r => r.id))
export function isShapePracticeEligible(id: string): boolean {
  if (excludedShapeIds.has(id)) return false
  const event = completed.questions.find(q => q.id === id)
  const review = event?.detectionReview
  if (review && review.status !== 'legacy_not_reviewed_at_detection') return review.status === 'pass' && review.phases.length === 3
  return reviewedShapeIds.has(id)
}
export const activeShapeCount = allShapeQuestions.filter(q => isShapePracticeEligible(q.id)).length

export const shapePatternCatalog = [{
  id: 'channel-decay-reversal',
  name: '通道衰减反转',
  description: '强势窄通道 → 推进逐渐减弱 → 无方向横盘 → 反向收盘穿越EMA20；强势后直接横盘不符合（多空双向）',
}, {
  id: 'channel-decay-range-confirmed',
  name: '通道衰减·逐根识别事件',
  description: '只练习已通过形态复核且具有三阶段标注的事件；未通过或证据不足的事件保留在研究记录中，不进入题库。不按后续走势筛选，不等EMA20。',
}] as const

export interface ShapePatternOption {
  id: string
  name: string
  description: string
  total: number
  remaining: number
}

export function filterShapeCandidates(patternIds: readonly string[], excludedKeys: readonly string[] = []) {
  const selected = new Set(patternIds)
  return shapeDecisionCandidates.filter(c => isShapePracticeEligible(c.shapePracticeId ?? '') && c.shapePatternId && selected.has(c.shapePatternId) && !excludedKeys.includes(c.key))
}

// Derive completion from answers, not legacy reservation keys in live state.
export function confirmedShapeQuestionKeys(sessions: readonly DecisionReplaySession[]): string[] {
  const keys = new Set(shapeDecisionCandidates.map(candidate => candidate.key))
  return [...new Set(sessions.flatMap(session => session.attempts
    .filter(attempt => keys.has(attempt.candidateKey) && attempt.stage === 'complete' && Boolean(attempt.result))
    .map(attempt => attempt.candidateKey)))]
}

export function shapePatternOptions(seenKeys: readonly string[], excludedKeys: readonly string[] = []): ShapePatternOption[] {
  const seen = new Set(seenKeys)
  return shapePatternCatalog.map(pattern => {
    const candidates = filterShapeCandidates([pattern.id], excludedKeys)
    return { ...pattern, total: candidates.length, remaining: candidates.filter(c => !seen.has(c.key)).length }
  })
}

// These are chart exercises, not historical AI trades. Compatibility fields
// below are never used as a system benchmark or as an automatic exit.
export const shapeDecisionCandidates: ReplayDecisionCandidate[] = allShapeQuestions.map(q => {
  const signal = q.bars[q.startIndex]
  const verified = completed.questions.find(item => item.id === q.id)
  const pattern = shapePatternCatalog[verified ? 1 : 0]
  const sourceId = verified ? completed.id : raw.id
  const side = verified ? (verified.side === 'long' ? 'long' : 'short') : signal.close > q.ema20[q.startIndex] ? 'long' : 'short'
  const stop = side === 'long' ? signal.low : signal.high
  return {
    key: `${sourceId}:${q.id}`, shapePracticeId: q.id, shapePatternId: pattern.id, manualContinuation: true,
    sourceId, sourceName: pattern.name, symbol: 'XAUUSD', interval: '5m',
    scenario: '形态练习；无系统参考交易', backtestSha256: '',
    trade: {
      tradeNumber: verified ? verified.sourceIndex + 1 : Number(q.id.slice(1)), side,
      entry: {
        signalIdx: q.startIndex, signalTime: signal.time, time: signal.time,
        beijingTime: '', price: signal.close, setup: `${pattern.name} · ${verified ? `K${verified.sourceIndex}` : q.id}`,
        reason: verified?.reason ?? '观察此前通道推进减弱、扩宽和震荡的过程，结合当前K线决定是否参与。操作方式与自定义题目数量相同。',
        ruleVersion: '人工形态练习', triggerReference: '当前信号K线',
        triggerCondition: '由你使用现有决策菜单选择入场方式', stopLoss: stop,
        takeProfit: null, noFixedTakeProfitAtEntry: true, stopMethod: '由练习者设置',
        trailingActivationUsd: null, trailingDistanceUsd: null,
      },
      exit: {
        idx: q.bars.length, time: q.bars.at(-1)!.time + 300, beijingTime: '',
        price: signal.close, reasonCode: 'END_OF_DATA_MARK_TO_MARKET',
        ambiguous: false, finalActiveStop: stop, trailingActivated: false, trailingActivationIdx: null,
      },
      result: { barsHeld: 0, rMultiple: 0, pnlUsd: 0 },
    },
  }
})

export function shapeDecisionHistory(candidate: ReplayDecisionCandidate): Candle[] | null {
  if (!candidate.shapePracticeId) return null
  return allShapeQuestions.find(q => q.id === candidate.shapePracticeId)?.bars ?? []
}

export interface ShapeDetectionReview {
  status: string
  reason: string
  protocol?: string | null
  receipt?: string | null
  phases: { kind: string; startIndex: number; endIndex: number }[]
}
export function shapeDetectionReview(candidate: Pick<ReplayDecisionCandidate, 'shapePracticeId'>) {
  return (completed.questions as { id: string; detectionReview?: ShapeDetectionReview }[])
    .find(q => q.id === candidate.shapePracticeId)?.detectionReview
}

export function shapeAiReview(candidate: ReplayDecisionCandidate) {
  const detection=shapeDetectionReview(candidate)
  if(detection && detection.status!=='legacy_not_reviewed_at_detection') return {
    id:candidate.shapePracticeId!, verdict:detection.status==='pass'?'same-prefix-pass':'visual-review',
    shape_note:`同根同PNG即时复核：${detection.status==='pass'?'通过':detection.status==='fail'?'存在反证':'证据不足'}。${detection.reason} 原始候选保留，不按后续走势筛选。`,
    sourceLabel:'首次候选当根 · 同PNG即时复核', causal:{status:detection.status==='pass'?'signal' as const:'unconfirmed' as const,
      rangeConfirmedIndex:detection.status==='pass'?candidate.trade.entry.signalIdx:null,
      signalIndex:detection.status==='pass'?candidate.trade.entry.signalIdx:null,reason:detection.reason}
  }
  const disputed = annotationReviews.reviews.find(item => item.id === candidate.shapePracticeId)
  if (disputed) return { id: disputed.id, verdict: disputed.verdict === 'match' ? 'reviewed' : 'visual-review',
    shape_note: `${causalEventIds.has(disputed.id) ? '原始识别事件完整保留；当时未做即时复核。事后意见：' : ''}${disputed.verdict === 'match' ? '视觉符合' : disputed.verdict === 'nonmatch' ? '复核存在反证' : '证据不足'}：${disputed.note}`,
    sourceLabel: '仅截至原记录K的视觉复核 · 原始事件保留', causal: { status: 'unconfirmed' as const,
      rangeConfirmedIndex: null, signalIndex: null, reason: disputed.note } }
  const verified = completed.questions.find(item => item.id === candidate.shapePracticeId)
  if (verified) return { id: verified.id, verdict: 'visual-review', shape_note: `原始识别事件完整保留，复核状态见来源记录；尚未完成区间标注核对。原模型记录：${verified.reason}`,
    sourceLabel: '原始逐根事件 · 待区间复核', causal: { status: 'unconfirmed' as const,
      rangeConfirmedIndex: null, signalIndex: null,
      reason: '阶段确认点尚未核对为真实区间，不能直接宣称形态成立。' } }
  const causal = validateShapeSequence([], [], [], 'long')
  const original = reviews.reviews.find(review => review.id === candidate.shapePracticeId)
  if (original) return { ...original, sourceLabel: '历史形态候选 · 因果未验证', causal }
  const note = (curation.added_notes as Record<string, string>)[candidate.shapePracticeId ?? '']
  return note ? { id: candidate.shapePracticeId!, verdict: 'strong', shape_note: note, sourceLabel: '历史视觉候选 · 因果未验证', causal } : null
}

export function shapeAiMarkers(candidate: ReplayDecisionCandidate | null, revealedThrough: number): SeriesMarker<UTCTimestamp>[] {
  if (!candidate || !shapeAiReview(candidate) || candidate.trade.entry.signalTime > revealedThrough) return []
  const isLong = candidate.trade.side === 'long'
  const verified = shapeAiReview(candidate)?.causal.status === 'signal'
  return [{ id: `shape-ai-${candidate.key}`, time: candidate.trade.entry.signalTime as UTCTimestamp,
    position: isLong ? 'belowBar' : 'aboveBar', color: isLong ? '#14b8a6' : '#ef4444',
    shape: isLong ? 'arrowUp' : 'arrowDown', text: shapeAiReview(candidate)?.verdict === 'visual-review' ? '原始事件：未通过形态复核' : shapeAiReview(candidate)?.verdict === 'reviewed' ? '三阶段形态 · 原记录定位' : verified ? (isLong ? '下跌衰减：首次震荡' : '上涨衰减：首次震荡') : isLong ? '形态候选：偏多（未验证）' : '形态候选：偏空（未验证）' }]
}

export const SHAPE_EXCLUSIONS_KEY = 'kline-shape-excluded-questions-v1'
export function loadShapeExclusions(): string[] {
  try { const value: unknown = JSON.parse(localStorage.getItem(SHAPE_EXCLUSIONS_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : []
  } catch { return [] }
}
export function removeShapeQuestion(session: DecisionReplaySession, key: string): DecisionReplaySession {
  const index = session.candidates.findIndex(candidate => candidate.key === key && candidate.shapePracticeId)
  if (index < 0) return session
  const candidates = session.candidates.filter(candidate => candidate.key !== key)
  const attempts = session.attempts.filter(attempt => attempt.candidateKey !== key)
  const currentIndex = index < session.currentIndex ? session.currentIndex - 1 : session.currentIndex
  const next = candidates[currentIndex]
  if (next && !attempts.some(attempt => attempt.candidateKey === next.key)) attempts.push(createDecisionAttempt(next))
  return { ...session, candidates, attempts, currentIndex, requestedCount: candidates.length,
    status: next ? session.status : 'stopped', updatedAt: Date.now(), finishedAt: next ? session.finishedAt : Date.now() }
}

export function applyShapeCuration(current: DecisionReplayStore): DecisionReplayStore {
  const active = current.sessions.find(session => session.id === current.activeSessionId)
  if (!active) return current
  const rejected = active.candidates.filter(candidate => candidate.shapePracticeId && !isShapePracticeEligible(candidate.shapePracticeId)
    && !active.attempts.some(attempt => attempt.candidateKey === candidate.key && (attempt.stage === 'complete' || attempt.result || attempt.stage === 'position-open')))
  if (!rejected.length) return current
  const updated = rejected.reduce((session, candidate) => removeShapeQuestion(session, candidate.key), active)
  return { ...current, activeSessionId: updated.status === 'active' ? updated.id : null,
    sessions: current.sessions.map(session => session.id === active.id ? updated : session) }
}
