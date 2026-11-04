import { describe, expect, it } from 'vitest'
import { shapeDecisionCandidates, shapeDecisionHistory } from './shapeDecisionPractice'
import {
  buildShapePhaseSegments, isShapePhaseAnnotationVisible, missingShapePhaseKinds,
  parseShapePhaseAnnotations, shapePhaseAnnotationFor,
} from './shapePhaseAnnotations'

describe('shape phase annotations', () => {
  it('keeps every rendered boundary at or before the signal candle', () => {
    const candidate = shapeDecisionCandidates.find((item) => item.shapePracticeId === 'M14')!
    const bars = shapeDecisionHistory(candidate)!
    const signalIndex = candidate.trade.entry.signalIdx
    const complete = buildShapePhaseSegments(candidate, bars, signalIndex)
    expect(complete).toHaveLength(3)
    expect(complete.every((segment) => segment.startIndex >= 0 && segment.endIndex <= signalIndex)).toBe(true)

    const partial = buildShapePhaseSegments(candidate, bars, 200)
    expect(partial.every((segment) => segment.startIndex >= 0 && segment.endIndex <= 200)).toBe(true)
    expect(partial.every((segment) => segment.endTime <= bars[200].time)).toBe(true)
  })

  it('does not render phase segments for a non-shape candidate', () => {
    const candidate = { ...shapeDecisionCandidates[0], shapePracticeId: undefined }
    expect(buildShapePhaseSegments(candidate, shapeDecisionHistory(shapeDecisionCandidates[0])!)).toEqual([])
    expect(shapePhaseAnnotationFor(candidate)).toBeNull()
  })

  it('keeps incomplete and hidden review states explicit', () => {
    const [incomplete] = parseShapePhaseAnnotations({ annotations: [{
      id: 'M99', status: 'incomplete', note: '缺少宽通道', phases: [
        { kind: 'narrow', startIndex: 1, endIndex: 2 },
        { kind: 'range', startIndex: 2, endIndex: 3 },
      ],
    }] })
    expect(isShapePhaseAnnotationVisible(incomplete)).toBe(true)
    expect(missingShapePhaseKinds(incomplete)).toEqual(['wide'])
    expect(isShapePhaseAnnotationVisible({ ...incomplete, status: 'hidden' })).toBe(false)
  })
})


it('has three causal phases for every retained or added question', async () => {
 const { filterShapeCandidates } = await import('./shapeDecisionPractice')
 for (const candidate of filterShapeCandidates(['channel-decay-reversal'])) {
   const segments=buildShapePhaseSegments(candidate)
   expect(segments.map(s=>s.kind)).toEqual(['narrow','wide','range'])
   expect(segments.every(s=>s.endTime<=candidate.trade.entry.signalTime)).toBe(true)
 }
})
