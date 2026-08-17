import type { Candle, IntervalId, SymbolId } from './market'
import { INTERVALS } from './market'

export interface ReplaySpeed {
  value: number
  label: string
  detail: string
  delay: number
}

export interface ReplayResolution {
  seconds: number
  label: string
  shortLabel: string
}

export interface ReplaySession {
  symbol: SymbolId
  interval: IntervalId
  cursorTime: number
  speed: number
  resolutionSeconds: number
  autoResolution: boolean
}

export const REPLAY_SESSION_KEY = 'kline-studio-replay-session-v1'

export const REPLAY_SPEEDS: ReplaySpeed[] = [
  { value: 10, label: '10x', detail: '每1秒更新10次', delay: 100 },
  { value: 7, label: '7x', detail: '每1秒更新7次', delay: 143 },
  { value: 5, label: '5x', detail: '每1秒更新5次', delay: 200 },
  { value: 3, label: '3x', detail: '每1秒更新3次', delay: 333 },
  { value: 1, label: '1x', detail: '每1秒更新1次', delay: 1000 },
  { value: 0.5, label: '0.5x', detail: '每2秒更新1次', delay: 2000 },
  { value: 0.3, label: '0.3x', detail: '每3秒更新1次', delay: 3000 },
  { value: 0.2, label: '0.2x', detail: '每5秒更新1次', delay: 5000 },
  { value: 0.1, label: '0.1x', detail: '每10秒更新1次', delay: 10000 },
]

const RESOLUTIONS: ReplayResolution[] = [
  { seconds: 60, label: '1 分钟', shortLabel: '1分' },
  { seconds: 180, label: '3 分钟', shortLabel: '3分' },
  { seconds: 300, label: '5 分钟', shortLabel: '5分' },
  { seconds: 900, label: '15 分钟', shortLabel: '15分' },
  { seconds: 1800, label: '30 分钟', shortLabel: '30分' },
  { seconds: 3600, label: '1 小时', shortLabel: '1小时' },
  { seconds: 7200, label: '2 小时', shortLabel: '2小时' },
  { seconds: 14400, label: '4 小时', shortLabel: '4小时' },
  { seconds: 86400, label: '1 天', shortLabel: '1天' },
  { seconds: 604800, label: '1 周', shortLabel: '1周' },
]

export function replayResolutions(interval: IntervalId): ReplayResolution[] {
  const chartSeconds = INTERVALS[interval].seconds
  const minimum = chartSeconds >= INTERVALS['1w'].seconds ? 86400 : 60
  return RESOLUTIONS.filter((item) => item.seconds >= minimum && item.seconds <= chartSeconds && chartSeconds % item.seconds === 0)
}

export function replaySpeed(value: number): ReplaySpeed {
  return REPLAY_SPEEDS.find((item) => item.value === value) ?? REPLAY_SPEEDS[0]
}

export function nearestReplayTime(data: Candle[], requestedTime: number): number {
  if (data.length === 0) return requestedTime
  if (requestedTime <= data[0].time) return data[0].time
  const end = data.at(-1)!.time
  if (requestedTime >= end) return end
  let low = 0
  let high = data.length - 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (data[middle].time <= requestedTime) low = middle + 1
    else high = middle - 1
  }
  return data[Math.max(0, high)].time
}

function interpolatedPrice(candle: Candle, progress: number) {
  const rising = candle.close >= candle.open
  const prices = rising
    ? [candle.open, candle.low, candle.high, candle.close]
    : [candle.open, candle.high, candle.low, candle.close]
  const stops = [0, 0.28, 0.62, 1]
  const p = Math.max(0, Math.min(1, progress))
  let segment = 0
  while (segment < stops.length - 2 && p > stops[segment + 1]) segment += 1
  const local = (p - stops[segment]) / (stops[segment + 1] - stops[segment])
  const price = prices[segment] + (prices[segment + 1] - prices[segment]) * local
  const visited = prices.slice(0, segment + 1).concat(price)
  return {
    price,
    high: Math.max(...visited),
    low: Math.min(...visited),
  }
}

export function replayCandles(data: Candle[], cursorTime: number, chartSeconds: number): Candle[] {
  if (data.length === 0) return []
  const result: Candle[] = []
  for (const candle of data) {
    if (candle.time > cursorTime) break
    const elapsed = cursorTime - candle.time
    if (elapsed >= chartSeconds) {
      result.push(candle)
      continue
    }
    const progress = Math.max(0, Math.min(1, elapsed / chartSeconds))
    const partial = interpolatedPrice(candle, progress)
    result.push({
      ...candle,
      high: Math.max(candle.open, partial.high),
      low: Math.min(candle.open, partial.low),
      close: partial.price,
      volume: Math.max(1, Math.round(candle.volume * Math.max(progress, 0.02))),
    })
  }
  return result
}

export function advanceReplayTime(cursorTime: number, seconds: number, data: Candle[], chartSeconds: number) {
  if (data.length === 0) return { time: cursorTime, ended: true }
  const end = data.at(-1)!.time + chartSeconds
  const time = Math.min(end, cursorTime + seconds)
  return { time, ended: time >= end }
}

export function loadReplaySession(): ReplaySession | null {
  try {
    const raw = window.localStorage.getItem(REPLAY_SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ReplaySession>
    if (!parsed.symbol || !parsed.interval || !Number.isFinite(parsed.cursorTime) || !Number.isFinite(parsed.speed) || !Number.isFinite(parsed.resolutionSeconds)) return null
    return parsed as ReplaySession
  } catch {
    return null
  }
}

export function saveReplaySession(session: ReplaySession | null) {
  try {
    if (session) window.localStorage.setItem(REPLAY_SESSION_KEY, JSON.stringify(session))
    else window.localStorage.removeItem(REPLAY_SESSION_KEY)
  } catch {
    // Storage may be unavailable in private or embedded browser contexts.
  }
}
