/** Confirmation must be recorded at the current bar, before searching later bars for entry. */
export type ShapePhase = 'searching' | 'narrow' | 'wide' | 'range' | 'invalid'
export interface ShapeObservation {
  index: number
  visibleThroughIndex: number
  phase: ShapePhase
  evidence: string
}
export interface ShapeSequenceResult {
  status: 'invalid' | 'unconfirmed' | 'waiting' | 'signal'
  rangeConfirmedIndex: number | null
  signalIndex: number | null
  reason: string
}
export function validateShapeSequence(
  closes: readonly number[], ema: readonly number[], observations: readonly ShapeObservation[],
  direction: 'long' | 'short',
): ShapeSequenceResult {
  const result = (status: ShapeSequenceResult['status'], reason: string, rangeConfirmedIndex: number | null = null, signalIndex: number | null = null): ShapeSequenceResult => ({ status, reason, rangeConfirmedIndex, signalIndex })
  if (!observations.length) return result('unconfirmed', '缺少逐根识别记录，不能把候选定位K当作信号')
  let phase: ShapePhase = 'searching'
  let confirmed: number | null = null
  let signal: number | null = null
  for (let j = 0; j < observations.length; j++) {
    const o = observations[j]
    if (o.index !== j || o.visibleThroughIndex !== j || !o.evidence.trim()
      || !Number.isFinite(closes[j]) || !Number.isFinite(ema[j])) return result('invalid', '逐根记录缺失、未来数据或证据缺失')
    if (signal !== null) continue // A later better-looking cross cannot replace the first signal.
    if (o.phase === 'invalid') return result('invalid', '结构在信号前失效，须另起新结构记录')
    const allowed: Record<ShapePhase, ShapePhase[]> = {
      searching: ['searching', 'narrow'], narrow: ['narrow', 'wide'],
      wide: ['wide', 'range'], range: ['range'], invalid: [],
    }
    if (!allowed[phase].includes(o.phase)) return result('invalid', '阶段缺失或倒退，不能把直接震荡补成宽通道')
    // Confirmation bar is not itself an entry: wait until a subsequent close.
    if (confirmed !== null && j > confirmed) {
      const cross = direction === 'long'
        ? closes[j] > ema[j] && closes[j - 1] <= ema[j - 1]
        : closes[j] < ema[j] && closes[j - 1] >= ema[j - 1]
      if (cross) signal = j
    }
    if (o.phase === 'range' && phase !== 'range') confirmed = j
    phase = o.phase
  }
  return signal !== null ? result('signal', '震荡确认后首次收盘穿越', confirmed, signal)
    : confirmed !== null ? result('waiting', '已确认震荡，等待后续首次收盘穿越', confirmed)
    : result('unconfirmed', '尚未按顺序确认三个阶段')
}
