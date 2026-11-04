import annotationReviews from '../data/shape-annotation-reviews.json'
import { shapeDecisionHistory, shapeDetectionReview } from './shapeDecisionPractice'
import type { ReplayDecisionCandidate } from './replayTradeRegistry'
import type { Candle } from './market'

export type ShapePhaseKind = 'narrow' | 'wide' | 'range'

export interface ShapePhaseBoundary {
  kind: ShapePhaseKind
  startIndex: number
  endIndex: number
}

export interface ShapePhaseAnnotation {
  id: string
  status: string
  note: string
  phases: ShapePhaseBoundary[]
}

export interface ShapePhaseSegment extends ShapePhaseBoundary {
  id: string
  label: string
  color: string
  startTime: number
  endTime: number
  startPrice: number
  endPrice: number
}

export const SHAPE_PHASE_KINDS: readonly ShapePhaseKind[] = ['narrow', 'wide', 'range']

export const SHAPE_PHASE_LABELS: Record<ShapePhaseKind, string> = {
  narrow: '窄通道',
  wide: '宽通道',
  range: '震荡区间',
}

export const SHAPE_PHASE_COLORS: Record<ShapePhaseKind, string> = {
  narrow: '#38bdf8',
  wide: '#fb923c',
  range: '#c084fc',
}

const hiddenStatuses = new Set(['hidden', 'hide', 'excluded', 'disabled', 'skip'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asFiniteInteger(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) ? value : null
}

function isShapePhaseKind(value: unknown): value is ShapePhaseKind {
  return value === 'narrow' || value === 'wide' || value === 'range'
}

/**
 * Parse the hand drawn review file at the edge of the data boundary. Invalid
 * rows are ignored so a partially edited review file cannot create geometry.
 */
export function parseShapePhaseAnnotations(value: unknown): ShapePhaseAnnotation[] {
  if (!isRecord(value) || !Array.isArray(value.annotations)) return []
  return value.annotations.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id.trim() === '' || !Array.isArray(item.phases)) return []
    const phases = item.phases.flatMap((phase) => {
      if (!isRecord(phase) || !isShapePhaseKind(phase.kind)) return []
      const startIndex = asFiniteInteger(phase.startIndex)
      const endIndex = asFiniteInteger(phase.endIndex)
      if (startIndex === null || endIndex === null || startIndex < 0 || endIndex < startIndex) return []
      return [{ kind: phase.kind, startIndex, endIndex }]
    })
    return [{
      id: item.id,
      status: typeof item.status === 'string' ? item.status : 'review',
      note: typeof item.note === 'string' ? item.note : '',
      phases,
    }]
  })
}

// Model state-change points are provenance, never drawable phase intervals.
// Unreviewed imports cannot silently fall back to old or generated arrows.
export const shapePhaseAnnotations = parseShapePhaseAnnotations({ annotations: annotationReviews.reviews })

export function shapePhaseAnnotationFor(candidate: Pick<ReplayDecisionCandidate, 'shapePracticeId'> | null | undefined): ShapePhaseAnnotation | null {
  const id = candidate?.shapePracticeId
  if (!id) return null
  const detection = shapeDetectionReview(candidate!)
  if (detection?.status === 'pass') return parseShapePhaseAnnotations({annotations:[{
    id,status:'same-prefix-reviewed',note:detection.reason,phases:detection.phases,
  }]}).find(a=>a.phases.length===3) ?? null
  return shapePhaseAnnotations.find((annotation) => annotation.id === id) ?? null
}

// Keep a descriptive alias for consumers that prefer a getter style name.
export const getShapePhaseAnnotation = shapePhaseAnnotationFor

export function isShapePhaseAnnotationVisible(annotation: Pick<ShapePhaseAnnotation, 'status'> | null | undefined) {
  if (!annotation) return false
  return !hiddenStatuses.has(annotation.status.trim().toLowerCase())
}

export function shapePhaseStatusLabel(status: string) {
  const normalized = status.trim().toLowerCase()
  if (normalized === 'incomplete') return '不完整 · 待复核'
  if (normalized === 'review') return '待复核'
  if (normalized === 'visual-review') return '区间草图 · 待复核'
  if (normalized === 'reviewed') return '前缀视觉复核 · 非首次确认时间'
  if (normalized === 'same-prefix-reviewed') return '同根同PNG即时复核通过'
  if (normalized === 'causal-confirmations') return '逐根记录确认点'
  if (hiddenStatuses.has(normalized)) return '已隐藏'
  return status.trim() || '待复核'
}

export function missingShapePhaseKinds(annotation: Pick<ShapePhaseAnnotation, 'phases'> | null | undefined): ShapePhaseKind[] {
  if (!annotation) return [...SHAPE_PHASE_KINDS]
  const present = new Set(annotation.phases.map((phase) => phase.kind))
  return SHAPE_PHASE_KINDS.filter((kind) => !present.has(kind))
}

function meanCloseAround(bars: readonly Candle[], index: number, maxIndex: number) {
  const values: number[] = []
  for (let offset = -3; offset <= 3; offset += 1) {
    if (offset === 0) continue
    const candidateIndex = index + offset
    if (candidateIndex < 0 || candidateIndex > maxIndex || candidateIndex >= bars.length) continue
    const close = bars[candidateIndex]?.close
    if (typeof close === 'number' && Number.isFinite(close)) values.push(close)
  }
  if (values.length === 0) {
    const close = bars[index]?.close
    return typeof close === 'number' && Number.isFinite(close) ? close : null
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function candidateSignalIndex(candidate: Pick<ReplayDecisionCandidate, 'trade'>, bars: readonly Candle[]) {
  const declared = candidate.trade.entry.signalIdx
  if (Number.isInteger(declared) && declared >= 0 && declared < bars.length) return declared
  const byTime = bars.findIndex((bar) => bar.time === candidate.trade.entry.signalTime)
  return byTime >= 0 ? byTime : null
}

/**
 * Resolve review boundaries into chart-ready segments. The effective end is
 * always capped by both the signal candle and the currently revealed candle,
 * so no phase or price can read a future bar during causal playback.
 */
export function buildShapePhaseSegments(
  candidate: ReplayDecisionCandidate,
  bars: readonly Candle[] = shapeDecisionHistory(candidate) ?? [],
  revealedThroughIndex = Number.POSITIVE_INFINITY,
): ShapePhaseSegment[] {
  const annotation = shapePhaseAnnotationFor(candidate)
  if (!annotation || !isShapePhaseAnnotationVisible(annotation) || bars.length === 0) return []
  const signalIndex = candidateSignalIndex(candidate, bars)
  if (signalIndex === null) return []
  const revealIndex = Number.isFinite(revealedThroughIndex) ? Math.trunc(revealedThroughIndex) : signalIndex
  const maxIndex = Math.min(signalIndex, revealIndex, bars.length - 1)
  if (maxIndex < 0) return []

  return annotation.phases.flatMap((phase, phaseIndex) => {
    if (phase.startIndex > maxIndex || phase.endIndex < 0) return []
    const startIndex = Math.max(0, phase.startIndex)
    const endIndex = Math.min(maxIndex, phase.endIndex)
    if (startIndex > endIndex) return []
    const startPrice = meanCloseAround(bars, startIndex, maxIndex)
    const endPrice = meanCloseAround(bars, endIndex, maxIndex)
    if (startPrice === null || endPrice === null) return []
    const horizontalPrice = (startPrice + endPrice) / 2
    return [{
      ...phase,
      id: `${candidate.shapePracticeId ?? candidate.key}-phase-${phaseIndex}`,
      startIndex,
      endIndex,
      label: `${SHAPE_PHASE_LABELS[phase.kind]} · ${endIndex - startIndex + 1}根`,
      color: SHAPE_PHASE_COLORS[phase.kind],
      startTime: bars[startIndex].time,
      endTime: bars[endIndex].time,
      startPrice: phase.kind === 'range' ? horizontalPrice : startPrice,
      endPrice: phase.kind === 'range' ? horizontalPrice : endPrice,
    }]
  })
}

// Alias used by chart code and useful to callers that think in terms of the
// rendered result rather than the construction step.
export const shapePhaseSegments = buildShapePhaseSegments
