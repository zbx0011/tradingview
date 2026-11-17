// Phone app: one random NQ trading day, revealed one candle per tap, with the desktop indicators
// (EMA, Smart Money Concepts incl. refilled gaps and session-open / US-open dashed lines, three pushes, AB=CD, trendlines).
import { CandlestickSeries, LineSeries, LineStyle, createChart, type CandlestickData, type ISeriesApi, type LineData, type SeriesType, type UTCTimestamp } from 'lightweight-charts'
import { attachAbcdOverlay } from '../lib/abcdOverlay'
import { attachAutoTrendlinesOverlay, type AutoTrendlinesMode } from '../lib/autoTrendlinesOverlay'
import { futureTradingBarTimes } from '../lib/futureTradingTimeline'
import { setAllAbcdTimeframes, toggleAbcdTimeframe, visibleAbcdTimeframes, type AbcdSettings } from '../lib/abcdSettings'
import { formatBeijingChartTime, formatBeijingTickMark } from '../lib/chartTime'
import { DEFAULT_INDICATORS, ema as emaLine } from '../lib/indicators'
import type { Candle } from '../lib/market'
import { attachSmartMoneyOverlay } from '../lib/smartMoneyOverlay'
import { attachThreePushOverlay } from '../lib/threePushOverlay'
import type { ThreePushMinuteSource } from '../lib/threePushProjection'
import { setAllThreePushTimeframes, toggleThreePushTimeframe, visibleThreePushTimeframes, type ThreePushSettings } from '../lib/threePushSettings'

type Row = [time: number, open: number, high: number, low: number, close: number]
interface Segment { id: number; start: number; end: number; n: number; day: boolean; label: string }
interface DayIndex { symbol: string; segments: Segment[] }
/** view: the visible range as distances from the newest bar, so the chart reopens scrolled and zoomed as it was left. */
interface SavedState { segment: number; cursor: number; seconds: number; used: number[]; view?: { from: number; to: number } }
/** Every day looked at, with how far it got: kept on the phone so a day can be picked up again. */
interface ViewedDay { id: number; label: string; cursor: number; end: number; seconds: number; lastSeen: number }

const STORAGE_KEY = 'kline-mobile-practice-v1'
const HISTORY_KEY = 'kline-mobile-history-v1'
const CONTEXT_SESSIONS = 3
const DATA_BASE = new URLSearchParams(location.search).get('data') ?? './days/'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const messageEl = $<HTMLDivElement>('message')
const badgeEl = $<HTMLDivElement>('badge')
const nextEl = $<HTMLButtonElement>('next')
const intervalButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#intervals button'))

const chartEl = $<HTMLDivElement>('chart')
const chart = createChart(chartEl, {
  autoSize: true,
  layout: { background: { color: '#ffffff' }, textColor: '#30384a', fontSize: 11, attributionLogo: false },
  grid: { vertLines: { color: '#f0f2f6' }, horzLines: { color: '#f0f2f6' } },
  rightPriceScale: { borderColor: '#d9dde5' },
  timeScale: { borderColor: '#d9dde5', timeVisible: true, secondsVisible: false, rightOffset: 30, barSpacing: 7, minBarSpacing: 1.5, tickMarkFormatter: formatBeijingTickMark },
  localization: { locale: 'zh-CN', timeFormatter: formatBeijingChartTime },
  crosshair: { mode: 0 },
})
const candles = chart.addSeries(CandlestickSeries, {
  upColor: '#ffffff', downColor: '#111111', borderUpColor: '#111111', borderDownColor: '#111111', wickUpColor: '#111111', wickDownColor: '#111111',
  priceFormat: { type: 'price', precision: 2, minMove: 0.25 },
  // Current price: grey dashed line.
  priceLineColor: '#9aa0a6', priceLineStyle: LineStyle.Dashed, priceLineWidth: 1,
})
const ema = chart.addSeries(LineSeries, { color: '#2962ff', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false })

// Same indicators and defaults as the desktop chart.
const overlaySeries = candles as unknown as ISeriesApi<SeriesType>
const smc = attachSmartMoneyOverlay(chartEl, chart, candles, true)
// Show the refilled gap bands, like the desktop with 已回补缺口 on.
smc.setShowFilledGaps(true)
// Three pushes, AB=CD and trendlines can be switched per timeframe / mode from the side panel (saved on the phone).
interface IndicatorChoice extends ThreePushSettings, AbcdSettings { trend: boolean; trendMode: AutoTrendlinesMode }
const INDICATOR_KEY = 'kline-mobile-indicators-v1'
function loadIndicators(): IndicatorChoice {
  const base: IndicatorChoice = { ...DEFAULT_INDICATORS, trend: true, trendMode: 'near' }
  try {
    const saved = JSON.parse(localStorage.getItem(INDICATOR_KEY) ?? 'null') as Partial<IndicatorChoice> | null
    return saved ? { ...base, ...saved, trendMode: saved.trendMode === 'recent' ? 'recent' : 'near' } : base
  } catch { return base }
}
let choice = loadIndicators()
let threePush = attachThreePushOverlay(chart, overlaySeries, { timeframes: visibleThreePushTimeframes(choice), mergeOverlaps: DEFAULT_INDICATORS.threePushMergeOverlaps, tapToSelect: true })
let abcd = attachAbcdOverlay(chart, overlaySeries, { levels: visibleAbcdTimeframes(choice), tapToSelect: true })
// Trendlines like the desktop: 默认 = only the lines the latest candle is near, 最近 = every unbroken line.
let trendlines: ReturnType<typeof attachAutoTrendlinesOverlay> | null = choice.trend ? attachAutoTrendlinesOverlay(chart, overlaySeries, choice.trendMode) : null

let dayIndex: DayIndex | null = null
let day: Segment | null = null
/** Context sessions followed by the practice day, 1-minute candles. */
let minutes: Candle[] = []
let cursor = 0
let seconds = 300
let used: number[] = []
let busy = false

const showMessage = (text: string | null) => {
  messageEl.hidden = text === null
  if (text !== null) messageEl.textContent = text
}

function loadState(): SavedState | null {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as SavedState | null
    if (!value || !Number.isFinite(value.segment) || !Number.isFinite(value.cursor)) return null
    const view = value.view && Number.isFinite(value.view.from) && Number.isFinite(value.view.to) && value.view.from > value.view.to ? value.view : undefined
    return { segment: value.segment, cursor: value.cursor, seconds: [60, 300, 900, 3600].includes(value.seconds) ? value.seconds : 300, used: Array.isArray(value.used) ? value.used.filter(Number.isFinite) : [], view }
  } catch { return null }
}
function loadHistory(): Record<string, ViewedDay> {
  try { return (JSON.parse(localStorage.getItem(HISTORY_KEY) ?? 'null') as Record<string, ViewedDay> | null) ?? {} } catch { return {} }
}
let shownBars = 0
function currentView() {
  const range = chart.timeScale().getVisibleLogicalRange()
  return range ? { from: shownBars - range.from, to: shownBars - range.to } : undefined
}
function saveState() {
  if (!day) return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ segment: day.id, cursor, seconds, used, view: currentView() } satisfies SavedState))
    const history = loadHistory()
    history[day.id] = { id: day.id, label: day.label, cursor, end: day.end, seconds, lastSeen: Date.now() }
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history))
  } catch { /* storage may be unavailable */ }
}

async function fetchJson<T>(name: string): Promise<T> {
  const response = await fetch(`${DATA_BASE}${name}`)
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`)
  return await response.json() as T
}

/** Aggregated candles for everything revealed so far (context + the day up to the cursor). */
function revealed(): Candle[] {
  const bars: Candle[] = []
  let current: Candle | null = null
  for (const minute of minutes) {
    if (minute.time >= cursor) break
    const start = Math.floor(minute.time / seconds) * seconds
    if (!current || current.time !== start) {
      current = { ...minute, time: start }
      bars.push(current)
    } else {
      if (minute.high > current.high) current.high = minute.high
      if (minute.low < current.low) current.low = minute.low
      current.close = minute.close
    }
  }
  return bars
}

const toBar = (bar: Candle): CandlestickData<UTCTimestamp> => ({ time: bar.time as UTCTimestamp, open: bar.open, high: bar.high, low: bar.low, close: bar.close })
const toPoint = (point: { time: number, value: number }): LineData<UTCTimestamp> => ({ time: point.time as UTCTimestamp, value: point.value })

/**
 * Bar times still to come: the rest of the loaded day, then the next session from the day index (times only,
 * its prices are never loaded), so the next day's grey open line is waiting past the end of this day too.
 */
function futureTimes(after: number): number[] {
  const LIMIT = 432
  const times = futureTradingBarTimes(minutes, after, seconds, LIMIT)
  const next = day && dayIndex ? dayIndex.segments.find((item) => item.id === day!.id + 1) : undefined
  if (next) {
    for (let time = Math.floor(next.start / seconds) * seconds; time < next.end && times.length < LIMIT; time += seconds) {
      if (time > after && time > (times.at(-1) ?? -Infinity)) times.push(time)
    }
  }
  return times
}

/** Like the desktop: 1m patterns are projected onto the 5m chart from the minute tape, never past the cursor. */
function updateOverlays(bars: Candle[]) {
  const source: ThreePushMinuteSource | undefined = seconds === 300 ? { candles: minutes, endTime: cursor } : undefined
  // Times (never prices) of the bars still to come, so the session-open and US-open lines ahead are already drawn.
  const last = bars.at(-1)
  smc.setFutureTimes(last ? futureTimes(last.time) : [])
  smc.setData(bars)
  threePush.setData(bars, source)
  abcd.setData(bars, source)
  trendlines?.setData(bars)
}

/** Day candles at the current interval: how many are revealed and how many there are in total. */
function progress() {
  if (!day) return { done: 0, total: 0 }
  const buckets = new Set<number>()
  let done = 0
  for (const { time } of minutes) {
    if (time < day.start) continue
    const start = Math.floor(time / seconds) * seconds
    if (!buckets.has(start)) { buckets.add(start); if (time < cursor) done += 1 }
  }
  return { done, total: buckets.size }
}

function refreshPanel() {
  if (!day) return
  const { done, total } = progress()
  const finished = cursor >= day.end
  badgeEl.innerHTML = `<b>NQ1!</b> · ${day.label} · ${done}/${total}`
  nextEl.classList.toggle('done', finished)
  if (!swiping) nextEl.innerHTML = finished ? '本日结束<small>点这里换一天</small>' : `下一根<small>${done}/${total}</small>`
  for (const button of intervalButtons) button.classList.toggle('on', Number(button.dataset.seconds) === seconds)
}

/** Redraw everything and put the newest candle near the right edge. */
function redraw(view?: { from: number; to: number }) {
  const bars = revealed()
  shownBars = bars.length
  candles.setData(bars.map(toBar))
  ema.setData(emaLine(bars, DEFAULT_INDICATORS.emaPeriod).map(toPoint))
  updateOverlays(bars)
  // A dragged price axis switches auto-scale off; turn it back on so the candles are always in view.
  chart.priceScale('right').applyOptions({ autoScale: true })
  const visible = Math.max(40, Math.floor(chart.timeScale().width() / 7))
  chart.timeScale().setVisibleLogicalRange(view ? { from: bars.length - view.from, to: bars.length - view.to } : { from: bars.length - visible + 30, to: bars.length + 30 })
  refreshPanel()
}

function step() {
  if (!day || busy) return
  if (cursor >= day.end) { void startDay(null); return }
  // Advance to the end of the candle the cursor is in; skip empty stretches so every tap shows something new.
  const from = cursor
  let next = cursor
  do {
    next = Math.min(day.end, (Math.floor(next / seconds) + 1) * seconds)
  } while (next < day.end && !minutes.some(({ time }) => time >= from && time < next))
  cursor = next
  const bars = revealed()
  shownBars = bars.length
  const last = bars.at(-1)
  const lastLine = emaLine(bars, DEFAULT_INDICATORS.emaPeriod).at(-1)
  if (last) candles.update(toBar(last))
  if (lastLine) ema.update(toPoint(lastLine))
  updateOverlays(bars)
  saveState()
  refreshPanel()
}

async function startDay(saved: SavedState | null) {
  if (!dayIndex || busy) return
  busy = true
  showMessage('正在载入交易日…')
  try {
    const eligible = dayIndex.segments.filter((item) => item.day && item.id >= CONTEXT_SESSIONS)
    let target = saved ? eligible.find((item) => item.id === saved.segment) ?? null : null
    if (!target) {
      const fresh = eligible.filter((item) => !used.includes(item.id))
      const pool = fresh.length > 0 ? fresh : eligible
      if (fresh.length === 0) used = []
      target = pool[Math.floor(Math.random() * pool.length)] ?? null
    }
    if (!target) throw new Error('没有可用的交易日数据')
    const firstId = target.id - CONTEXT_SESSIONS
    const ids = Array.from({ length: CONTEXT_SESSIONS + 1 }, (_, offset) => firstId + offset)
    const parts = await Promise.all(ids.map((id) => fetchJson<Row[]>(`${id}.json`)))
    minutes = parts.flat().map(([time, open, high, low, close]) => ({ time, open, high, low, close, volume: 0 }))
    day = target
    // Resume where this day was left: the last session's state, else the day's entry in the viewing history.
    const resume = saved && saved.segment === target.id ? saved.cursor : loadHistory()[target.id]?.cursor
    cursor = resume !== undefined ? Math.min(Math.max(resume, target.start), target.end) : target.start
    if (!used.includes(target.id)) used.push(target.id)
    redraw(saved && saved.segment === target.id ? saved.view : undefined)
    saveState()
    showMessage(null)
  } catch (error) {
    showMessage(`载入失败\n${error instanceof Error ? error.message : String(error)}`)
  } finally {
    busy = false
  }
}

// --- controls ---------------------------------------------------------------------------------
function applyChoice(next: IndicatorChoice) {
  choice = next
  try { localStorage.setItem(INDICATOR_KEY, JSON.stringify(choice)) } catch { /* storage may be unavailable */ }
  threePush.destroy(); abcd.destroy(); trendlines?.destroy()
  threePush = attachThreePushOverlay(chart, overlaySeries, { timeframes: visibleThreePushTimeframes(choice), mergeOverlaps: DEFAULT_INDICATORS.threePushMergeOverlaps, tapToSelect: true })
  abcd = attachAbcdOverlay(chart, overlaySeries, { levels: visibleAbcdTimeframes(choice), tapToSelect: true })
  trendlines = choice.trend ? attachAutoTrendlinesOverlay(chart, overlaySeries, choice.trendMode) : null
  if (day) updateOverlays(revealed())
  renderToggles()
}
const TF_COLORS: Record<string, string> = { '1m': '#4d8bff', '5m': '#f08c00', '15m': '#c060e0' }
const ABCD_COLOR = '#ff5a5a', TREND_COLOR = '#4d8bff'
const togglesEl = $<HTMLDivElement>('toggles')
function chip(label: string, color: string, on: boolean, master: boolean, onTap: () => void) {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.className = `${master ? 'master' : ''}${on ? ' on' : ''}`
  button.style.setProperty('--c', color)
  button.addEventListener('click', onTap)
  return button
}
function renderToggles() {
  togglesEl.replaceChildren()
  const pushes = visibleThreePushTimeframes(choice), levels = visibleAbcdTimeframes(choice)
  const pushRow = document.createElement('div'); pushRow.className = 'toggle-row'
  pushRow.append(chip('三推', '#4d8bff', pushes.length > 0, true, () => applyChoice(setAllThreePushTimeframes(choice, pushes.length === 0))))
  for (const tf of ['1m', '5m', '15m'] as const) pushRow.append(chip(`${tf.replace('m', 'min')}`, TF_COLORS[tf], pushes.includes(tf), false, () => applyChoice(toggleThreePushTimeframe(choice, tf))))
  const abcdRow = document.createElement('div'); abcdRow.className = 'toggle-row'
  abcdRow.append(chip('AB=CD', ABCD_COLOR, levels.length > 0, true, () => applyChoice(setAllAbcdTimeframes(choice, levels.length === 0))))
  for (const tf of ['1m', '5m', '15m', '30m', '1h'] as const) abcdRow.append(chip(tf.replace('m', 'min'), ABCD_COLOR, levels.includes(tf), false, () => applyChoice(toggleAbcdTimeframe(choice, tf))))
  const trendRow = document.createElement('div'); trendRow.className = 'toggle-row'
  trendRow.append(chip('趋势线', TREND_COLOR, choice.trend, true, () => applyChoice({ ...choice, trend: !choice.trend })))
  trendRow.append(chip('默认', TREND_COLOR, choice.trend && choice.trendMode === 'near', false, () => applyChoice({ ...choice, trend: true, trendMode: 'near' })))
  trendRow.append(chip('最近', TREND_COLOR, choice.trend && choice.trendMode === 'recent', false, () => applyChoice({ ...choice, trend: true, trendMode: 'recent' })))
  togglesEl.append(pushRow, abcdRow, trendRow)
}
renderToggles()

// Tap = one candle; holding the button keeps stepping.
// Swipe right on the button and keep the finger there for 3 seconds = change to another day.
const SWIPE_PX = 40, SWIPE_HOLD_MS = 3000
let holdDelay = 0
let holdRepeat = 0
let swiping = false
let swipeTimer = 0
let swipeTick = 0
let startX = 0
const stopHold = () => { window.clearTimeout(holdDelay); window.clearInterval(holdRepeat); nextEl.classList.remove('down') }
const stopSwipe = () => {
  window.clearTimeout(swipeTimer); window.clearInterval(swipeTick)
  if (!swiping) return
  swiping = false
  nextEl.classList.remove('swipe')
  refreshPanel()
}
const startSwipe = () => {
  stopHold()
  swiping = true
  nextEl.classList.add('swipe')
  const until = Date.now() + SWIPE_HOLD_MS
  const show = () => { nextEl.innerHTML = `换一天<small>保持 ${Math.max(0, Math.ceil((until - Date.now()) / 1000))} 秒</small>` }
  show()
  swipeTick = window.setInterval(show, 200)
  swipeTimer = window.setTimeout(() => { stopSwipe(); void startDay(null) }, SWIPE_HOLD_MS)
}
let lastPointerDown = 0
nextEl.addEventListener('pointerdown', (event) => {
  event.preventDefault()
  try { nextEl.setPointerCapture(event.pointerId) } catch { /* not every input supports capture */ }
  lastPointerDown = Date.now()
  startX = event.clientX
  stopHold(); stopSwipe()
  nextEl.classList.add('down')
  const finished = day !== null && cursor >= day.end
  step()
  if (finished) return
  holdDelay = window.setTimeout(() => {
    holdRepeat = window.setInterval(() => { if (day && cursor >= day.end) stopHold(); else step() }, 110)
  }, 450)
})
nextEl.addEventListener('pointermove', (event) => {
  if (!nextEl.classList.contains('down') && !swiping) return
  const right = event.clientX - startX >= SWIPE_PX
  if (right && !swiping) startSwipe()
  else if (!right && swiping) { stopSwipe(); nextEl.classList.add('down') }
})
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) nextEl.addEventListener(name, () => { lastPointerDown = Date.now(); stopHold(); stopSwipe() })
// Fallback for input that produces a click without pointer events.
nextEl.addEventListener('click', () => { if (Date.now() - lastPointerDown > 1000) step() })
nextEl.addEventListener('contextmenu', (event) => event.preventDefault())

for (const button of intervalButtons) {
  button.addEventListener('click', () => {
    const value = Number(button.dataset.seconds)
    if (value === seconds || !day) return
    seconds = value
    saveState()
    redraw()
  })
}

// Keep the scroll / zoom too, and save whenever the app goes to the background or closes.
let viewSaveTimer = 0
chart.timeScale().subscribeVisibleLogicalRangeChange(() => { window.clearTimeout(viewSaveTimer); viewSaveTimer = window.setTimeout(saveState, 400) })
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveState() })
window.addEventListener('pagehide', saveState)

async function main() {
  try {
    dayIndex = await fetchJson<DayIndex>('index.json')
    const saved = loadState()
    if (saved) { seconds = saved.seconds; used = saved.used }
    await startDay(saved)
  } catch (error) {
    showMessage(`载入失败\n${error instanceof Error ? error.message : String(error)}`)
  }
}
void main()
