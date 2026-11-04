import { expect, it } from 'vitest'
import data from '../../public/data/shape-practice/causal-range-confirmations.json'
import audit from '../data/shape-annotation-reviews.json'
import curation from '../data/shape-curation.json'
import { filterShapeCandidates, shapeAiReview, shapeDecisionCandidates, shapeDecisionHistory, shapePatternOptions, confirmedShapeQuestionKeys } from './shapeDecisionPractice'
import { createDecisionSession, createDecisionAttempt } from './decisionReplay'
import { buildShapePhaseSegments } from './shapePhaseAnnotations'

// Legacy events are retained in the source data, but only audited matches
// with three valid phases enter the practice pool.
const eligibleEventIds = data.questions.filter(q => {
  if (curation.excluded_ids.includes(q.id)) return false
  if (q.detectionReview.status !== 'legacy_not_reviewed_at_detection') {
    return q.detectionReview.status === 'pass' && q.detectionReview.phases.length === 3
  }
  const review = audit.reviews.find(r => r.id === q.id)
  return review?.verdict === 'match' && review.endIndex === q.startIndex && review.phases.length === 3
    && review.phases.every((p, i) => p.kind === ['narrow', 'wide', 'range'][i]
      && Number.isInteger(p.startIndex) && Number.isInteger(p.endIndex)
      && p.startIndex >= 0 && p.startIndex < p.endIndex && p.endIndex <= review.endIndex
      && (i === 0 || p.startIndex >= review.phases[i - 1].endIndex))
}).map(q => q.id)

it('renders full reviewed intervals, never confirmation points, and is invariant to future candles', () => {
  for (const candidate of shapeDecisionCandidates) {
    const review = audit.reviews.find(r => r.id === candidate.shapePracticeId)!
    expect(review).toBeTruthy()
    const bars = shapeDecisionHistory(candidate)!
    const segments = buildShapePhaseSegments(candidate, bars)
    if (review.verdict !== 'match') { expect(segments).toEqual([]); continue }
    expect(segments.map(s => s.kind)).toEqual(['narrow','wide','range'])
    for (const segment of segments) {
      expect(segment.startIndex).toBeLessThan(segment.endIndex)
      expect(segment.endTime).toBeLessThanOrEqual(candidate.trade.entry.signalTime)
    }
    const modified = bars.map((b,i) => i>candidate.trade.entry.signalIdx ? {...b,open:999999,high:999999,low:999999,close:999999} : b)
    expect(buildShapePhaseSegments(candidate,modified)).toEqual(segments)
    expect(shapeAiReview(candidate)?.causal.status).toBe('unconfirmed')
  }
})

it('preserves all original events and times even when the visual interpretation failed', () => {
  expect(data.questions).toHaveLength(9)
  expect(data.sources.map(s => s.eventCount)).toEqual([6, 3])
  for (const q of data.questions) {
    const candidate=shapeDecisionCandidates.find(c=>c.shapePracticeId===q.id)!
    expect(candidate.trade.side).toBe(q.originalTrend === 'bear' ? 'long' : 'short')
    expect(candidate.trade.entry.signalTime).toBe(q.signalTime)
    expect(shapeDecisionHistory(candidate)![q.startIndex].time).toBe(q.signalTime)
    expect(createDecisionAttempt(candidate).cursorTime).toBe(q.signalTime)
  }
  const active=filterShapeCandidates(['channel-decay-range-confirmed'])
  expect(active.map(c=>c.shapePracticeId)).toEqual(eligibleEventIds)
})

it('counts only eligible questions while retaining unfinished and historical answers', () => {
  const fresh = filterShapeCandidates(['channel-decay-range-confirmed'])
  const session = createDecisionSession(fresh, 1)
  expect(shapePatternOptions(confirmedShapeQuestionKeys([session])).find(p => p.id === 'channel-decay-range-confirmed')).toMatchObject({total: eligibleEventIds.length, remaining: eligibleEventIds.length})
})

it('does not assert a first causal recognition time from visual interval boundaries', () => {
  expect(audit.reviews).toHaveLength(39)
  for (const review of audit.reviews) {
    expect(review.causalRecognitionVerified).toBe(false)
    expect(review.prefixSha256).toMatch(/^[a-f0-9]{64}$/)
    const c=shapeDecisionCandidates.find(c=>c.shapePracticeId===review.id)!
    if(review.verdict!=='match' && c.shapePatternId!=='channel-decay-range-confirmed') expect(filterShapeCandidates([c.shapePatternId!]).some(x=>x.key===c.key)).toBe(false)
  }
})
