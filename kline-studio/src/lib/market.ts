export type SymbolId = 'XAUUSD' | 'XAGUSD' | 'BTCUSDT.P' | 'US500' | 'ETHUSD'
export type IntervalId = '1m' | '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '1d' | '1w'

export interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface SymbolInfo {
  id: SymbolId
  name: string
  exchange: string
  basePrice: number
  volatility: number
  precision: number
  accent: string
}

export const SYMBOLS: SymbolInfo[] = [
  { id: 'XAUUSD', name: '黄金现货/美元', exchange: 'OANDA', basePrice: 4260, volatility: 0.0019, precision: 3, accent: '#f2b90b' },
  { id: 'XAGUSD', name: '白银现货/美元', exchange: 'OANDA', basePrice: 34, volatility: 0.0032, precision: 3, accent: '#b7c4d6' },
  { id: 'BTCUSDT.P', name: '比特币/泰达币永续', exchange: 'BYBIT', basePrice: 64800, volatility: 0.0054, precision: 1, accent: '#f7931a' },
  { id: 'US500', name: '标普500指数', exchange: 'ICMARKETS', basePrice: 6400, volatility: 0.0016, precision: 1, accent: '#6da7ff' },
  { id: 'ETHUSD', name: '以太坊/美元', exchange: 'COINBASE', basePrice: 3890, volatility: 0.0065, precision: 2, accent: '#627eea' },
]

export const INTERVALS: Record<IntervalId, { label: string; seconds: number }> = {
  '1m': { label: '1分', seconds: 60 },
  '5m': { label: '5分', seconds: 300 },
  '15m': { label: '15分', seconds: 900 },
  '30m': { label: '30分', seconds: 1800 },
  '1h': { label: '1小时', seconds: 3600 },
  '2h': { label: '2小时', seconds: 7200 },
  '4h': { label: '4小时', seconds: 14400 },
  '1d': { label: '日', seconds: 86400 },
  '1w': { label: '周', seconds: 604800 },
}

function hash(input: string) {
  let value = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    value ^= input.charCodeAt(i)
    value = Math.imul(value, 16777619)
  }
  return value >>> 0
}

function mulberry32(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function generateCandles(symbolId: SymbolId, interval: IntervalId, count = 1600): Candle[] {
  const symbol = SYMBOLS.find((item) => item.id === symbolId) ?? SYMBOLS[0]
  const step = INTERVALS[interval].seconds
  const random = mulberry32(hash(`${symbolId}:${interval}:kline-studio`))
  const anchor = 1_775_688_000 // Fixed anchor for repeatable tests and screenshots.
  const end = Math.floor(anchor / step) * step
  const result: Candle[] = []
  let close = symbol.basePrice * (0.96 + random() * 0.015)

  for (let index = 0; index < count; index += 1) {
    const progress = index / Math.max(count - 1, 1)
    const cycle = Math.sin(index / 41) * symbol.volatility * 0.55
    const regime = index > count * 0.89 ? symbol.volatility * 0.008 : index > count * 0.74 ? -symbol.volatility * 0.005 : symbol.volatility * 0.001
    const impulse = progress > 0.958 && progress < 0.986 ? symbol.volatility * 0.24 : 0
    const noise = (random() - 0.5) * symbol.volatility * 0.55
    const open = close
    close = Math.max(0.01, open * (1 + noise + cycle * 0.14 + regime + impulse))
    const wick = open * symbol.volatility * (0.2 + random() * 0.8)
    const high = Math.max(open, close) + wick * (0.35 + random())
    const low = Math.max(0.01, Math.min(open, close) - wick * (0.35 + random()))
    const burst = progress > 0.93 && progress < 0.995 ? 2.25 : 1
    const volume = Math.round((180 + random() * 880) * burst * (1 + Math.abs(close - open) / open / symbol.volatility))
    const factor = 10 ** symbol.precision
    result.push({
      time: end - (count - index - 1) * step,
      open: Math.round(open * factor) / factor,
      high: Math.round(high * factor) / factor,
      low: Math.round(low * factor) / factor,
      close: Math.round(close * factor) / factor,
      volume,
    })
  }
  if (symbolId === 'XAUUSD' && result.length > 0) {
    const targetClose = symbol.basePrice * 1.01923
    const scale = targetClose / result[result.length - 1].close
    const factor = 10 ** symbol.precision
    for (const candle of result) {
      candle.open = Math.round(candle.open * scale * factor) / factor
      candle.high = Math.round(candle.high * scale * factor) / factor
      candle.low = Math.round(candle.low * scale * factor) / factor
      candle.close = Math.round(candle.close * scale * factor) / factor
    }
  }
  return result
}

export function aggregateCandles(candles: Candle[], bucketSeconds: number): Candle[] {
  if (bucketSeconds <= 0) throw new Error('bucketSeconds must be positive')
  const buckets = new Map<number, Candle>()
  for (const candle of candles) {
    const time = Math.floor(candle.time / bucketSeconds) * bucketSeconds
    const existing = buckets.get(time)
    if (!existing) {
      buckets.set(time, { ...candle, time })
    } else {
      existing.high = Math.max(existing.high, candle.high)
      existing.low = Math.min(existing.low, candle.low)
      existing.close = candle.close
      existing.volume += candle.volume
    }
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time)
}

export function formatPrice(value: number, symbolId: SymbolId) {
  const precision = SYMBOLS.find((item) => item.id === symbolId)?.precision ?? 2
  return value.toLocaleString('zh-CN', { minimumFractionDigits: precision, maximumFractionDigits: precision })
}
