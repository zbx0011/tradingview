// Canvas overlay that renders the Smart Money Concepts layer on top of a
// lightweight-charts instance. Adapted from "Smart Money Concepts [LuxAlgo]"
// (© LuxAlgo, CC BY-NC-SA 4.0).
import type { IChartApi, Logical } from 'lightweight-charts'
import type { Candle } from './market'
import { computeSmartMoney, emptySmcResult, SMC_COLORS, type SmcResult } from './smartMoney'

interface Overlay {
  setData: (candles: readonly Candle[]) => void
  setFutureTimes: (times: readonly number[]) => void
  destroy: () => void
}

const FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif'

function withAlpha(hex: string, alpha: number) {
  const value = hex.replace('#', '')
  const red = parseInt(value.slice(0, 2), 16)
  const green = parseInt(value.slice(2, 4), 16)
  const blue = parseInt(value.slice(4, 6), 16)
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

// Trading-day bucketing for the previous day high / low (PDH / PDL). CME
// futures roll their session at 18:00 New York time; everything else uses UTC days.
const newYorkParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' })

function newYorkSessionKey(time: number) {
  const parts: Record<string, string> = {}
  for (const part of newYorkParts.formatToParts(new Date(time * 1000))) parts[part.type] = part.value
  const day = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / 86_400_000
  return Number(parts.hour) >= 18 ? day + 1 : day
}

const utcDayKey = (time: number) => Math.floor(time / 86_400)

// US cash open (09:30 New York) marker: the first intraday candle that reaches the open on each day.
const newYorkHourFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit' })
const newYorkHourMemo = new Map<number, number>()
function newYorkMinuteOfDay(time: number) {
  const hourBucket = Math.floor(time / 3600)
  let hour = newYorkHourMemo.get(hourBucket)
  if (hour === undefined) { hour = Number(newYorkHourFormat.format(new Date(hourBucket * 3_600_000))) % 24; newYorkHourMemo.set(hourBucket, hour) }
  return hour * 60 + (Math.floor(time / 60) % 60)
}
const beijingClock = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })
const US_OPEN_MINUTE = 9 * 60 + 30
const US_CLOSE_MINUTE = 16 * 60

export interface PreviousDayLevels {
  high: number
  highIndex: number
  low: number
  lowIndex: number
}

/** High / low of the trading day before the last candle's day (scans backwards only). */
export function previousDayLevels(candles: readonly Candle[], dayKey: (time: number) => number): PreviousDayLevels | null {
  if (candles.length < 2) return null
  const currentKey = dayKey(candles[candles.length - 1].time)
  let previousKey: number | null = null
  let levels: PreviousDayLevels | null = null
  for (let index = candles.length - 1; index >= 0; index -= 1) {
    const candle = candles[index]
    const key = dayKey(candle.time)
    if (key === currentKey) continue
    if (previousKey === null) previousKey = key
    if (key !== previousKey) break
    if (!levels) levels = { high: candle.high, highIndex: index, low: candle.low, lowIndex: index }
    else {
      if (candle.high > levels.high) { levels.high = candle.high; levels.highIndex = index }
      if (candle.low < levels.low) { levels.low = candle.low; levels.lowIndex = index }
    }
  }
  return levels
}

export function attachSmartMoneyOverlay(container: HTMLElement, chart: IChartApi, series: any, futuresSession = false): Overlay {
  const rawDayKey = futuresSession ? newYorkSessionKey : utcDayKey
  // Hour-level memo keeps the Intl lookups cheap while panning a long history.
  const hourKeys = new Map<number, number>()
  const dayKey = futuresSession
    ? (time: number) => {
        const hour = Math.floor(time / 3600)
        let key = hourKeys.get(hour)
        if (key === undefined) { key = rawDayKey(hour * 3600); hourKeys.set(hour, key) }
        return key
      }
    : rawDayKey
  let levelsCache: PreviousDayLevels | null = null
  const canvas = document.createElement('canvas')
  canvas.setAttribute('data-testid', 'smc-overlay')
  canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:2;'
  container.appendChild(canvas)
  const context = canvas.getContext('2d')
  const timeScale = chart.timeScale()

  let result: SmcResult = emptySmcResult()
  let lastData: readonly Candle[] | null = null
  let futureTimes: readonly number[] = []
  let dataVersion = 0
  let signature = ''
  let frame = 0
  let destroyed = false

  const x = (index: number) => timeScale.logicalToCoordinate(index as Logical)
  const y = (price: number) => series.priceToCoordinate(price) as number | null

  function draw(paneWidth: number, paneHeight: number, dpr: number) {
    if (!context) return
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, canvas.width, canvas.height)
    const range = timeScale.getVisibleLogicalRange()
    if (!range || result.lastIndex < 0) return
    context.save()
    context.beginPath()
    context.rect(0, 0, paneWidth, paneHeight)
    context.clip()

    const barWidth = timeScale.logicalToCoordinate(1 as Logical) !== null && timeScale.logicalToCoordinate(0 as Logical) !== null
      ? (timeScale.logicalToCoordinate(1 as Logical) as number) - (timeScale.logicalToCoordinate(0 as Logical) as number)
      : 7
    const half = Math.max(barWidth, 1) / 2
    const lastIndex = result.lastIndex

    const fillBox = (fromIndex: number, toIndex: number | 'edge', top: number, bottom: number, color: string) => {
      const x1 = x(fromIndex)
      const y1 = y(top)
      const y2 = y(bottom)
      if (x1 === null || y1 === null || y2 === null) return
      const x2 = toIndex === 'edge' ? paneWidth : x(toIndex)
      if (x2 === null) return
      context.fillStyle = color
      context.fillRect(Math.min(x1 - half, x2 + half), Math.min(y1, y2), Math.abs(x2 - x1) + barWidth, Math.max(Math.abs(y2 - y1), 1))
    }
    const text = (label: string, px: number, py: number, color: string, size: number, placement: 'above' | 'below' | 'left') => {
      context.font = `${size}px ${FONT_FAMILY}`
      context.fillStyle = color
      context.textBaseline = placement === 'above' ? 'bottom' : placement === 'below' ? 'top' : 'middle'
      context.textAlign = placement === 'left' ? 'right' : 'center'
      context.fillText(label, px, placement === 'above' ? py - 2 : placement === 'below' ? py + 2 : py)
    }
    const line = (x1: number, y1: number, x2: number, y2: number, color: string, dash: number[]) => {
      context.strokeStyle = color
      context.lineWidth = 1
      context.setLineDash(dash)
      context.beginPath()
      context.moveTo(x1, y1)
      context.lineTo(x2, y2)
      context.stroke()
      context.setLineDash([])
    }

    // Vertical markers: grey dashed = first candle of each trading day, red dashed = candle at the 09:30 New York
    // open. For futures practice the hidden (not yet revealed) bars ahead are projected on the bar grid, so
    // the lines and their times are already waiting where later candles will appear.
    if (lastData && lastData.length > 1) {
      const lastPos = lastData.length - 1
      const step = lastData[lastPos].time - lastData[lastPos - 1].time
      if (step > 0 && step < 86_400) {
        const horizon = futuresSession ? futureTimes.length : 0
        const timeAt = (index: number) => index <= lastPos ? lastData![index].time : futureTimes[index - lastPos - 1]
        const from = Math.max(1, Math.floor(range.from) - 1)
        const to = Math.min(lastPos + horizon, Math.ceil(range.to) + 1)
        const reachesOpen = (time: number) => {
          const minute = newYorkMinuteOfDay(time)
          return minute + step / 60 > US_OPEN_MINUTE && minute < US_CLOSE_MINUTE
        }
        const days: { px: number; time: number }[] = []
        const opens: { px: number; time: number }[] = []
        let previousKey = dayKey(timeAt(from - 1))
        let previousReached = reachesOpen(timeAt(from - 1))
        for (let index = from; index <= to; index += 1) {
          const time = timeAt(index)
          const key = dayKey(time)
          const reached = reachesOpen(time)
          const dayStart = key !== previousKey
          const openBar = reached && !previousReached
          previousKey = key
          previousReached = reached
          if (!dayStart && !openBar) continue
          const px = x(index)
          if (px === null) continue
          if (dayStart) days.push({ px: Math.round(px) + 0.5, time })
          if (openBar) opens.push({ px: Math.round(px) + 0.5, time })
        }
        const crowded = (marks: { px: number }[]) => marks.some((mark, i) => i > 0 && mark.px - marks[i - 1].px < 10)
        const paint = (marks: { px: number; time: number }[], color: string, label: (time: number) => string) => {
          if (crowded(marks)) return // zoomed far out the lines would turn into a haze
          context.strokeStyle = color
          context.fillStyle = color
          context.lineWidth = 1
          context.font = `11px ${FONT_FAMILY}`
          context.textAlign = 'left'
          context.textBaseline = 'bottom'
          let lastLabelX = -Infinity
          for (const mark of marks) {
            context.setLineDash([4, 4])
            context.beginPath()
            context.moveTo(mark.px, 0)
            context.lineTo(mark.px, paneHeight)
            context.stroke()
            context.setLineDash([])
            if (mark.px - lastLabelX >= 70) { context.fillText(label(mark.time), mark.px + 4, paneHeight - 4); lastLabelX = mark.px }
          }
        }
        paint(days, 'rgba(134, 139, 148, 0.85)', (time) => beijingClock.format(new Date(time * 1000)))
        paint(opens, 'rgba(242, 54, 69, 0.9)', (time) => `${beijingClock.format(new Date(time * 1000))} 美股开盘`)
      }
    }

    // Internal order blocks extend to the right edge (extend.right in the script).
    for (const block of result.orderBlocks) {
      fillBox(block.startIndex, 'edge', block.top, block.bottom, block.bullish ? SMC_COLORS.internalBullishOrderBlock : SMC_COLORS.internalBearishOrderBlock)
    }

    // Premium / equilibrium / discount zones.
    const trailing = result.trailing
    if (trailing) {
      const { top, bottom, pivotIndex } = trailing
      const mid = Math.round(0.5 * (pivotIndex + lastIndex))
      fillBox(pivotIndex, lastIndex, top, 0.95 * top + 0.05 * bottom, withAlpha(SMC_COLORS.red, 0.2))
      fillBox(pivotIndex, lastIndex, 0.525 * top + 0.475 * bottom, 0.525 * bottom + 0.475 * top, withAlpha(SMC_COLORS.yellow, 0.2))
      fillBox(pivotIndex, lastIndex, 0.95 * bottom + 0.05 * top, bottom, withAlpha(SMC_COLORS.green, 0.2))
      const midX = x(mid)
      const topY = y(top)
      const bottomY = y(bottom)
      const equilibriumY = y((top + bottom) / 2)
      const lastX = x(lastIndex)
      if (midX !== null && topY !== null) text('Premium', midX, topY, SMC_COLORS.red, 11, 'above')
      if (midX !== null && bottomY !== null) text('Discount', midX, bottomY, SMC_COLORS.green, 11, 'below')
      if (lastX !== null && equilibriumY !== null) text('Equilibrium', lastX + half, equilibriumY, SMC_COLORS.yellow, 11, 'left')

      // Strong / weak high and low (extended 20 bars past the last candle).
      const rightX = x(lastIndex + 20)
      const topLineX = x(trailing.topIndex)
      const bottomLineX = x(trailing.bottomIndex)
      if (rightX !== null && topLineX !== null && topY !== null) {
        line(topLineX, topY, rightX, topY, SMC_COLORS.blue, [])
        text(result.swingBias === -1 ? 'Strong High' : 'Weak High', rightX - 28, topY, SMC_COLORS.red, 9, 'above')
      }
      if (rightX !== null && bottomLineX !== null && bottomY !== null) {
        line(bottomLineX, bottomY, rightX, bottomY, SMC_COLORS.blue, [])
        text(result.swingBias === 1 ? 'Strong Low' : 'Weak Low', rightX - 28, bottomY, SMC_COLORS.green, 9, 'below')
      }
    }

    // Previous day high / low (PDH / PDL), extended 20 bars past the last candle.
    if (levelsCache) {
      const rightX = x(lastIndex + 20)
      const drawLevel = (label: string, price: number, index: number) => {
        const lx = x(index)
        const ly = y(price)
        if (rightX === null || lx === null || ly === null) return
        line(lx, ly, rightX, ly, SMC_COLORS.blue, [])
        context.font = `11px ${FONT_FAMILY}`
        context.fillStyle = SMC_COLORS.blue
        context.textBaseline = 'middle'
        context.textAlign = 'left'
        context.fillText(label, rightX + 6, ly)
      }
      drawLevel('PDH', levelsCache.high, levelsCache.highIndex)
      drawLevel('PDL', levelsCache.low, levelsCache.lowIndex)
    }

    // Equal highs / lows.
    for (const equal of result.equals) {
      if (equal.toIndex < range.from - 2 || equal.fromIndex > range.to + 2) continue
      const x1 = x(equal.fromIndex)
      const x2 = x(equal.toIndex)
      const y1 = y(equal.fromPrice)
      const y2 = y(equal.toPrice)
      if (x1 === null || x2 === null || y1 === null || y2 === null) continue
      const color = equal.high ? SMC_COLORS.red : SMC_COLORS.green
      line(x1, y1, x2, y2, color, [1, 3])
      text(equal.high ? 'EQH' : 'EQL', (x1 + x2) / 2, y2, color, 9, equal.high ? 'above' : 'below')
    }

    // Internal (dashed) and swing (solid) structure breaks.
    for (const structure of result.structures) {
      if (structure.toIndex < range.from - 2 || structure.fromIndex > range.to + 2) continue
      const x1 = x(structure.fromIndex)
      const x2 = x(structure.toIndex)
      const py = y(structure.price)
      if (x1 === null || x2 === null || py === null) continue
      const color = structure.bullish ? SMC_COLORS.green : SMC_COLORS.red
      line(x1, py, x2, py, color, structure.internal ? [5, 4] : [])
      const labelX = x(Math.round(0.5 * (structure.fromIndex + structure.toIndex)))
      if (labelX !== null) text(structure.tag, labelX, py, color, structure.internal ? 9 : 11, structure.bullish ? 'above' : 'below')
    }
    context.restore()
  }

  function render() {
    frame = 0
    if (destroyed) return
    const dpr = window.devicePixelRatio || 1
    const width = container.clientWidth
    const height = container.clientHeight
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      signature = ''
    }
    const range = timeScale.getVisibleLogicalRange()
    const probeA = series.priceToCoordinate(0)
    const probeB = series.priceToCoordinate(1000)
    const next = `${dataVersion}|${range?.from}|${range?.to}|${probeA}|${probeB}|${width}|${height}|${dpr}`
    if (next !== signature) {
      signature = next
      let paneWidth = width
      let paneHeight = height
      try {
        const size = chart.paneSize()
        paneWidth = size.width
        paneHeight = size.height
      } catch {
        // paneSize is unavailable before the first layout; fall back to the container.
      }
      draw(paneWidth, paneHeight, dpr)
    }
    schedule()
  }

  function schedule() {
    if (destroyed || frame) return
    frame = window.requestAnimationFrame(render)
  }

  schedule()

  return {
    setFutureTimes(times) {
      if (futureTimes === times) return
      futureTimes = times
      dataVersion += 1
      schedule()
    },
    setData(candles) {
      if (candles === lastData) return
      lastData = candles
      result = computeSmartMoney(candles)
      levelsCache = previousDayLevels(candles, dayKey)
      dataVersion += 1
      schedule()
    },
    destroy() {
      destroyed = true
      if (frame) window.cancelAnimationFrame(frame)
      canvas.remove()
    },
  }
}
