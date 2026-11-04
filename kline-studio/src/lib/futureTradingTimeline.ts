/** Build a time-only projection; future prices must never enter the chart. */
export function futureTradingBarTimes(minutes: readonly { time: number }[], after: number, seconds: number, limit = 432): number[] {
  const result: number[] = []
  for (const minute of minutes) {
    const time = Math.floor(minute.time / seconds) * seconds
    if (time <= after || time === result.at(-1)) continue
    result.push(time)
    if (result.length >= limit) break
  }
  return result
}

/** Relative logical position after the last visible bar, including closed-session gaps. */
export function futureTimeOffset(time: number, lastTime: number, future: readonly number[], seconds: number): number {
  if (!future.length) return (time - lastTime) / seconds
  let lo = 0, hi = future.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (future[mid] < time) lo = mid + 1
    else hi = mid
  }
  if (lo === future.length) return future.length + (time - future[future.length - 1]) / seconds
  const before = lo === 0 ? lastTime : future[lo - 1]
  return lo + (time - before) / (future[lo] - before)
}
