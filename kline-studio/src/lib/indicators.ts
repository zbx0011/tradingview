import type { Candle } from './market'

export interface LinePoint { time: number; value: number }
export interface BollingerPoint { time: number; middle: number; upper: number; lower: number }

export function sma(candles: Candle[], period: number): LinePoint[] {
  if (period < 1) return []
  const output: LinePoint[] = []
  let sum = 0
  candles.forEach((candle, index) => {
    sum += candle.close
    if (index >= period) sum -= candles[index - period].close
    if (index >= period - 1) output.push({ time: candle.time, value: sum / period })
  })
  return output
}

export function ema(candles: Candle[], period: number): LinePoint[] {
  if (period < 1 || candles.length === 0) return []
  const multiplier = 2 / (period + 1)
  let value = candles[0].close
  return candles.map((candle, index) => {
    value = index === 0 ? candle.close : (candle.close - value) * multiplier + value
    return { time: candle.time, value }
  })
}

export function bollinger(candles: Candle[], period: number, deviation: number): BollingerPoint[] {
  if (period < 1) return []
  const output: BollingerPoint[] = []
  for (let index = period - 1; index < candles.length; index += 1) {
    const values = candles.slice(index - period + 1, index + 1).map((item) => item.close)
    const middle = values.reduce((sum, value) => sum + value, 0) / period
    const variance = values.reduce((sum, value) => sum + (value - middle) ** 2, 0) / period
    const spread = Math.sqrt(variance) * deviation
    output.push({ time: candles[index].time, middle, upper: middle + spread, lower: middle - spread })
  }
  return output
}

export function volumeSma(candles: Candle[], period: number): LinePoint[] {
  if (period < 1) return []
  const output: LinePoint[] = []
  let sum = 0
  candles.forEach((candle, index) => {
    sum += candle.volume
    if (index >= period) sum -= candles[index - period].volume
    if (index >= period - 1) output.push({ time: candle.time, value: sum / period })
  })
  return output
}
