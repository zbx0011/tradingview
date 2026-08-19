export interface FibLevelGeometry {
  id: string
  value: number
  y: number
  price: number | null
}

export interface FibLabelGeometry extends FibLevelGeometry {
  labelY: number
}

export function fibLevelProgress(value: number, reverse: boolean) {
  return reverse ? 1 - value : value
}

export function calculateFibLevelGeometry(
  levels: Array<{ id: string; value: number }>,
  startY: number,
  endY: number,
  startPrice: number | null,
  endPrice: number | null,
  reverse: boolean,
  logarithmic = false,
): FibLevelGeometry[] {
  return levels.map((level) => {
    const progress = fibLevelProgress(level.value, reverse)
    return {
      ...level,
      y: startY + (endY - startY) * progress,
      price: startPrice === null || endPrice === null
        ? null
        : logarithmic && startPrice > 0 && endPrice > 0
          ? Math.exp(Math.log(startPrice) + (Math.log(endPrice) - Math.log(startPrice)) * progress)
          : startPrice + (endPrice - startPrice) * progress,
    }
  })
}

/**
 * TradingView keeps Fibonacci labels compact beside their levels.  When the
 * two anchors are almost level, exact label positions would overlap.  This
 * screen-space pass preserves the level lines and only fans out their labels.
 */
export function layoutFibLabels(
  levels: FibLevelGeometry[],
  viewportHeight: number,
  fontSize: number,
): FibLabelGeometry[] {
  if (levels.length === 0) return []
  const gap = Math.max(12, fontSize + 3)
  const padding = Math.max(4, fontSize / 2 + 2)
  const maxY = Math.max(padding, viewportHeight - padding)
  const sorted = levels
    .map((level, sourceIndex) => ({ ...level, sourceIndex, labelY: Math.min(maxY, Math.max(padding, level.y)) }))
    .sort((a, b) => a.labelY - b.labelY || a.value - b.value)

  for (let index = 1; index < sorted.length; index += 1) {
    sorted[index].labelY = Math.max(sorted[index].labelY, sorted[index - 1].labelY + gap)
  }
  if (sorted.at(-1)!.labelY > maxY) {
    sorted[sorted.length - 1].labelY = maxY
    for (let index = sorted.length - 2; index >= 0; index -= 1) {
      sorted[index].labelY = Math.min(sorted[index].labelY, sorted[index + 1].labelY - gap)
    }
  }
  if (sorted[0].labelY < padding) {
    const shift = padding - sorted[0].labelY
    sorted.forEach((level) => { level.labelY += shift })
  }

  return sorted
    .sort((a, b) => a.sourceIndex - b.sourceIndex)
    .map((level) => ({
      id: level.id,
      value: level.value,
      y: level.y,
      price: level.price,
      labelY: level.labelY,
    }))
}
