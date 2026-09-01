export type DecisionRiskLayoutRect = { left: number; right: number; top: number; bottom: number }

export const DECISION_RISK_CONTROL_GAP = 12

function overlapArea(left: DecisionRiskLayoutRect, right: DecisionRiskLayoutRect) {
  return Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left))
    * Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top))
}

export function decisionRiskControlLeft({ preferredLeft, minLeft, maxLeft, width, top, bottom, blockers }: {
  preferredLeft: number
  minLeft: number
  maxLeft: number
  width: number
  top: number
  bottom: number
  blockers: readonly DecisionRiskLayoutRect[]
}) {
  const boundedMaxLeft = Math.max(minLeft, maxLeft)
  const clamp = (left: number) => Math.max(minLeft, Math.min(boundedMaxLeft, left))
  const candidates = new Set<number>([clamp(preferredLeft), minLeft, boundedMaxLeft])
  for (const blocker of blockers) {
    candidates.add(clamp(blocker.left - width - DECISION_RISK_CONTROL_GAP))
    candidates.add(clamp(blocker.right + DECISION_RISK_CONTROL_GAP))
  }
  // Edge candidates alone can still leave a wide control on top of several
  // small chart labels. Sample the remaining horizontal track as a fallback.
  const step = Math.max(28, Math.min(64, width / 3))
  for (let left = minLeft; left <= boundedMaxLeft; left += step) candidates.add(left)
  return [...candidates].reduce((best, left) => {
    const placed = { left, right: left + width, top, bottom }
    const overlap = blockers.reduce((sum, blocker) => sum + overlapArea(placed, blocker), 0)
    const score = overlap * 1000 + Math.abs(left - preferredLeft)
    return score < best.score ? { left, score, rect: placed } : best
  }, {
    left: minLeft,
    score: Infinity,
    rect: { left: minLeft, right: minLeft + width, top, bottom },
  })
}
