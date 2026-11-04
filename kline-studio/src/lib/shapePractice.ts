export const SHAPE_PRACTICE_STORAGE_KEY = 'kline-shape-practice-v1'
export const SHAPE_PRACTICE_STORAGE_VERSION = 1 as const
export const EXPECTED_SHAPE_PRACTICE_QUESTION_COUNT = 22
export const SHAPE_PRACTICE_RISK_USD = 100
export const DEFAULT_SHAPE_PRACTICE_WINDOW = 160

export interface ShapePracticeBar {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface ShapePracticeQuestion {
  id: string
  startIndex: number
  bars: ShapePracticeBar[]
  ema20: number[]
  signalTime: number
}

export interface ShapePracticeDataset {
  version: 1
  id: string
  symbol: string
  timeframeMinutes: number
  sourceSha256: string
  questions: ShapePracticeQuestion[]
}

export type ShapePracticeSide = 'long' | 'short'
export type ShapePracticeExitReason = 'stop-loss' | 'take-profit' | 'manual-close' | 'finished'

export interface ShapePracticePendingOrder {
  side: ShapePracticeSide
  stopLoss: number
  takeProfit?: number
  requestedAtIndex: number
  requestedAtTime: number
}

export interface ShapePracticePosition {
  side: ShapePracticeSide
  entryPrice: number
  entryIndex: number
  entryTime: number
  stopLoss: number
  takeProfit?: number
  quantity: number
  riskUsd: number
  manualCloseRequestedAtIndex?: number
}

export interface ShapePracticeTradeResult {
  side: ShapePracticeSide
  entryPrice: number
  entryIndex: number
  entryTime: number
  exitPrice: number
  exitIndex: number
  exitTime: number
  stopLoss: number
  takeProfit?: number
  quantity: number
  riskUsd: number
  pnlUsd: number
  rMultiple: number
  exitReason: ShapePracticeExitReason
  forcedAtFinish: boolean
}

export interface ShapePracticeProgress {
  cursor: number
  pendingOrder: ShapePracticePendingOrder | null
  position: ShapePracticePosition | null
  result: ShapePracticeTradeResult | null
  status: 'active' | 'completed'
  notice?: string
  updatedAt?: number
}

export interface ShapePracticeStore {
  version: 1
  datasetId: string
  selectedQuestionId: string
  questions: Record<string, ShapePracticeProgress>
}

export interface ShapePracticeActionResult {
  ok: boolean
  state: ShapePracticeProgress
  message?: string
}

export interface ShapePracticeStorageResult {
  ok: boolean
  state: ShapePracticeStore
  canPersist: boolean
  warning?: string
}

export interface ShapePracticeVisibleSlice {
  bars: ShapePracticeBar[]
  ema20: number[]
  startIndex: number
  endIndex: number
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function integer(value: unknown): value is number {
  return finiteNumber(value) && Number.isInteger(value)
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value))
}

function questionCursor(question: ShapePracticeQuestion, cursor: number) {
  if (question.bars.length === 0) return 0
  return clamp(Math.trunc(cursor), 0, question.bars.length - 1)
}

function activeQuestionCursor(question: ShapePracticeQuestion, cursor: number) {
  if (question.bars.length === 0) return 0
  return clamp(Math.trunc(cursor), Math.min(question.startIndex, question.bars.length - 1), question.bars.length - 1)
}

function copyProgress(progress: ShapePracticeProgress, question: ShapePracticeQuestion): ShapePracticeProgress {
  const cursor = activeQuestionCursor(question, finiteNumber(progress.cursor) ? progress.cursor : question.startIndex)
  return {
    cursor,
    pendingOrder: progress.pendingOrder ? { ...progress.pendingOrder } : null,
    position: progress.position ? { ...progress.position } : null,
    result: progress.result ? { ...progress.result } : null,
    status: progress.status === 'completed' || progress.result ? 'completed' : 'active',
    ...(progress.notice ? { notice: progress.notice } : {}),
    ...(finiteNumber(progress.updatedAt) ? { updatedAt: progress.updatedAt } : {}),
  }
}

function action(state: ShapePracticeProgress, ok: boolean, message?: string): ShapePracticeActionResult {
  return {
    ok,
    state,
    ...(message ? { message } : {}),
  }
}

function fail(state: ShapePracticeProgress, message: string): ShapePracticeActionResult {
  return action(state, false, message)
}

function sideStopIsValid(side: ShapePracticeSide, entryPrice: number, stopLoss: number) {
  return side === 'long' ? stopLoss < entryPrice : stopLoss > entryPrice
}

function sideTakeProfitIsValid(side: ShapePracticeSide, entryPrice: number, takeProfit: number) {
  return side === 'long' ? takeProfit > entryPrice : takeProfit < entryPrice
}

function entryDirectionLabel(side: ShapePracticeSide) {
  return side === 'long' ? '开多' : '开空'
}

function roundDisplay(value: number) {
  return Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 6 }) : '—'
}

function resultFromPosition(
  position: ShapePracticePosition,
  exitBar: ShapePracticeBar,
  exitPrice: number,
  exitReason: ShapePracticeExitReason,
  forcedAtFinish: boolean,
  exitIndex: number,
): ShapePracticeTradeResult {
  const points = position.side === 'long'
    ? exitPrice - position.entryPrice
    : position.entryPrice - exitPrice
  const pnlUsd = points * position.quantity
  return {
    side: position.side,
    entryPrice: position.entryPrice,
    entryIndex: position.entryIndex,
    entryTime: position.entryTime,
    exitPrice,
    exitIndex,
    exitTime: exitBar.time,
    stopLoss: position.stopLoss,
    ...(finiteNumber(position.takeProfit) ? { takeProfit: position.takeProfit } : {}),
    quantity: position.quantity,
    riskUsd: position.riskUsd,
    pnlUsd,
    rMultiple: position.riskUsd > 0 ? pnlUsd / position.riskUsd : 0,
    exitReason,
    forcedAtFinish,
  }
}

function stopHit(side: ShapePracticeSide, bar: ShapePracticeBar, stopLoss: number) {
  if (side === 'long') {
    if (bar.open <= stopLoss) return { price: bar.open, gap: true }
    if (bar.low <= stopLoss) return { price: stopLoss, gap: false }
  } else {
    if (bar.open >= stopLoss) return { price: bar.open, gap: true }
    if (bar.high >= stopLoss) return { price: stopLoss, gap: false }
  }
  return null
}

function takeProfitHit(side: ShapePracticeSide, bar: ShapePracticeBar, takeProfit: number) {
  if (side === 'long') {
    if (bar.open >= takeProfit) return { price: bar.open, gap: true }
    if (bar.high >= takeProfit) return { price: takeProfit, gap: false }
  } else {
    if (bar.open <= takeProfit) return { price: bar.open, gap: true }
    if (bar.low <= takeProfit) return { price: takeProfit, gap: false }
  }
  return null
}

function executePendingOrder(
  pending: ShapePracticePendingOrder,
  bar: ShapePracticeBar,
  index: number,
): { position: ShapePracticePosition | null; message: string } {
  if (!sideStopIsValid(pending.side, bar.open, pending.stopLoss)) {
    return {
      position: null,
      message: `${entryDirectionLabel(pending.side)}挂单已撤销：下一根开盘跳空后，止损方向失效（开盘 ${roundDisplay(bar.open)}）。`,
    }
  }

  const distance = Math.abs(bar.open - pending.stopLoss)
  if (!(distance > 0) || !Number.isFinite(distance)) {
    return { position: null, message: `${entryDirectionLabel(pending.side)}挂单已撤销：入场与止损距离无效。` }
  }
  const takeProfit = finiteNumber(pending.takeProfit) && sideTakeProfitIsValid(pending.side, bar.open, pending.takeProfit)
    ? pending.takeProfit
    : undefined
  const takeProfitMessage = finiteNumber(pending.takeProfit) && takeProfit === undefined
    ? ' 由于开盘跳空，止盈方向失效，已按无止盈入场。'
    : ''
  return {
    position: {
      side: pending.side,
      entryPrice: bar.open,
      entryIndex: index,
      entryTime: bar.time,
      stopLoss: pending.stopLoss,
      ...(takeProfit !== undefined ? { takeProfit } : {}),
      quantity: SHAPE_PRACTICE_RISK_USD / distance,
      riskUsd: SHAPE_PRACTICE_RISK_USD,
    },
    message: `${entryDirectionLabel(pending.side)}已在下一根开盘 ${roundDisplay(bar.open)} 成交，数量 ${roundDisplay(SHAPE_PRACTICE_RISK_USD / distance)}。${takeProfitMessage}`,
  }
}

/**
 * Validate the downloaded shape-practice dataset without looking at any answer metadata.
 * The default count is the production 22-question pack; tests may pass a smaller count.
 */
export function validateShapePracticeDataset(input: unknown, expectedQuestionCount = EXPECTED_SHAPE_PRACTICE_QUESTION_COUNT): { ok: true; data: ShapePracticeDataset } | { ok: false; error: string } {
  if (!isRecord(input)) return { ok: false, error: '题库格式错误：根对象不是 JSON 对象。' }
  if (input.version !== SHAPE_PRACTICE_STORAGE_VERSION) return { ok: false, error: '题库版本不受支持。' }
  if (typeof input.id !== 'string' || input.id.trim() === '') return { ok: false, error: '题库缺少有效 id。' }
  if (typeof input.symbol !== 'string' || input.symbol.trim() === '') return { ok: false, error: '题库缺少有效 symbol。' }
  if (!finiteNumber(input.timeframeMinutes) || input.timeframeMinutes <= 0) return { ok: false, error: '题库 timeframeMinutes 无效。' }
  if (typeof input.sourceSha256 !== 'string' || input.sourceSha256.trim() === '') return { ok: false, error: '题库缺少 sourceSha256。' }
  if (!Array.isArray(input.questions)) return { ok: false, error: '题库缺少 questions 数组。' }
  if (input.questions.length !== expectedQuestionCount) return { ok: false, error: `题库题数错误：读取到 ${input.questions.length} 题，期望 ${expectedQuestionCount} 题。` }

  const questions: ShapePracticeQuestion[] = []
  for (let questionIndex = 0; questionIndex < input.questions.length; questionIndex += 1) {
    const rawQuestion = input.questions[questionIndex]
    if (!isRecord(rawQuestion)) return { ok: false, error: `第 ${questionIndex + 1} 题格式错误。` }
    if (typeof rawQuestion.id !== 'string' || rawQuestion.id.trim() === '') return { ok: false, error: `第 ${questionIndex + 1} 题缺少 id。` }
    if (!integer(rawQuestion.startIndex) || rawQuestion.startIndex < 0) return { ok: false, error: `题目 ${rawQuestion.id} 的 startIndex 无效。` }
    if (!Array.isArray(rawQuestion.bars) || rawQuestion.bars.length <= rawQuestion.startIndex) return { ok: false, error: `题目 ${rawQuestion.id} 的 bars 不足以到达 startIndex。` }
    if (!Array.isArray(rawQuestion.ema20) || rawQuestion.ema20.length < rawQuestion.bars.length) return { ok: false, error: `题目 ${rawQuestion.id} 的 ema20 长度不足。` }
    if (!finiteNumber(rawQuestion.signalTime)) return { ok: false, error: `题目 ${rawQuestion.id} 的 signalTime 无效。` }
    const bars: ShapePracticeBar[] = []
    for (let barIndex = 0; barIndex < rawQuestion.bars.length; barIndex += 1) {
      const rawBar = rawQuestion.bars[barIndex]
      if (!isRecord(rawBar) || !finiteNumber(rawBar.time) || !finiteNumber(rawBar.open) || !finiteNumber(rawBar.high) || !finiteNumber(rawBar.low) || !finiteNumber(rawBar.close) || !finiteNumber(rawBar.volume)) {
        return { ok: false, error: `题目 ${rawQuestion.id} 的第 ${barIndex + 1} 根 K 线无效。` }
      }
      if (rawBar.high < Math.max(rawBar.open, rawBar.close) || rawBar.low > Math.min(rawBar.open, rawBar.close) || rawBar.low > rawBar.high) {
        return { ok: false, error: `题目 ${rawQuestion.id} 的第 ${barIndex + 1} 根 K 线高低点无效。` }
      }
      bars.push({ time: rawBar.time, open: rawBar.open, high: rawBar.high, low: rawBar.low, close: rawBar.close, volume: rawBar.volume })
    }
    const ema20 = rawQuestion.ema20.map((value) => Number(value))
    if (ema20.slice(0, bars.length).some((value) => !Number.isFinite(value))) return { ok: false, error: `题目 ${rawQuestion.id} 的 ema20 含无效值。` }
    questions.push({ id: rawQuestion.id, startIndex: rawQuestion.startIndex, bars, ema20, signalTime: rawQuestion.signalTime })
  }

  return {
    ok: true,
    data: {
      version: 1,
      id: input.id,
      symbol: input.symbol,
      timeframeMinutes: input.timeframeMinutes,
      sourceSha256: input.sourceSha256,
      questions,
    },
  }
}

export function assertShapePracticeDataset(input: unknown, expectedQuestionCount = EXPECTED_SHAPE_PRACTICE_QUESTION_COUNT): ShapePracticeDataset {
  const result = validateShapePracticeDataset(input, expectedQuestionCount)
  if (!result.ok) throw new Error(result.error)
  return result.data
}

export function createInitialShapePracticeProgress(question: ShapePracticeQuestion): ShapePracticeProgress {
  return {
    cursor: activeQuestionCursor(question, question.startIndex),
    pendingOrder: null,
    position: null,
    result: null,
    status: 'active',
  }
}

export function createInitialShapePracticeStore(dataset: ShapePracticeDataset): ShapePracticeStore {
  const questions: Record<string, ShapePracticeProgress> = {}
  for (const question of dataset.questions) questions[question.id] = createInitialShapePracticeProgress(question)
  return { version: 1, datasetId: dataset.id, selectedQuestionId: dataset.questions[0]?.id ?? '', questions }
}

function isPendingOrder(value: unknown): value is ShapePracticePendingOrder {
  if (!isRecord(value) || (value.side !== 'long' && value.side !== 'short')) return false
  return finiteNumber(value.stopLoss) && (value.takeProfit === undefined || finiteNumber(value.takeProfit)) && integer(value.requestedAtIndex) && finiteNumber(value.requestedAtTime)
}

function isPosition(value: unknown): value is ShapePracticePosition {
  if (!isRecord(value) || (value.side !== 'long' && value.side !== 'short')) return false
  return finiteNumber(value.entryPrice) && integer(value.entryIndex) && finiteNumber(value.entryTime) && finiteNumber(value.stopLoss) && (value.takeProfit === undefined || finiteNumber(value.takeProfit)) && finiteNumber(value.quantity) && value.quantity > 0 && finiteNumber(value.riskUsd) && value.riskUsd > 0 && (value.manualCloseRequestedAtIndex === undefined || integer(value.manualCloseRequestedAtIndex))
}

function isTradeResult(value: unknown): value is ShapePracticeTradeResult {
  if (!isRecord(value) || (value.side !== 'long' && value.side !== 'short')) return false
  if (!['stop-loss', 'take-profit', 'manual-close', 'finished'].includes(String(value.exitReason))) return false
  return finiteNumber(value.entryPrice) && integer(value.entryIndex) && finiteNumber(value.entryTime) && finiteNumber(value.exitPrice) && integer(value.exitIndex) && finiteNumber(value.exitTime) && finiteNumber(value.stopLoss) && (value.takeProfit === undefined || finiteNumber(value.takeProfit)) && finiteNumber(value.quantity) && value.quantity > 0 && finiteNumber(value.riskUsd) && value.riskUsd > 0 && finiteNumber(value.pnlUsd) && finiteNumber(value.rMultiple) && typeof value.forcedAtFinish === 'boolean'
}

function normalizeStoredProgress(question: ShapePracticeQuestion, value: unknown): ShapePracticeProgress {
  const fallback = createInitialShapePracticeProgress(question)
  if (!isRecord(value)) return fallback
  const cursor = integer(value.cursor) ? activeQuestionCursor(question, value.cursor) : fallback.cursor
  const pendingOrder = isPendingOrder(value.pendingOrder) && value.pendingOrder.requestedAtIndex < question.bars.length - 1
    ? { ...value.pendingOrder }
    : null
  const position = isPosition(value.position) && value.position.entryIndex <= cursor
    ? { ...value.position }
    : null
  const result = isTradeResult(value.result) ? { ...value.result } : null
  const status = value.status === 'completed' || result ? 'completed' : 'active'
  return {
    cursor,
    pendingOrder,
    position,
    result,
    status,
    ...(typeof value.notice === 'string' ? { notice: value.notice } : {}),
    ...(finiteNumber(value.updatedAt) ? { updatedAt: value.updatedAt } : {}),
  }
}

/** Merge saved progress into the current dataset while retaining every question id. */
export function mergeShapePracticeStore(dataset: ShapePracticeDataset, saved: unknown): ShapePracticeStore {
  const initial = createInitialShapePracticeStore(dataset)
  if (!isRecord(saved) || saved.version !== 1 || saved.datasetId !== dataset.id || !isRecord(saved.questions)) return initial
  const questions: Record<string, ShapePracticeProgress> = {}
  for (const question of dataset.questions) questions[question.id] = normalizeStoredProgress(question, saved.questions[question.id])
  const ids = new Set(dataset.questions.map((question) => question.id))
  const explicitlySelected = typeof saved.selectedQuestionId === 'string' && ids.has(saved.selectedQuestionId) ? saved.selectedQuestionId : ''
  const latestQuestion = dataset.questions.reduce<{ id: string; updatedAt: number } | null>((latest, question) => {
    const updatedAt = questions[question.id].updatedAt ?? 0
    return !latest || updatedAt > latest.updatedAt ? { id: question.id, updatedAt } : latest
  }, null)
  return { ...initial, selectedQuestionId: explicitlySelected || latestQuestion?.id || initial.selectedQuestionId, questions }
}

function browserStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** Read the one dedicated key. A storage error is returned for visible UI reporting. */
export function loadShapePracticeStore(dataset: ShapePracticeDataset, storage: Storage | null = browserStorage()): ShapePracticeStorageResult {
  const initial = createInitialShapePracticeStore(dataset)
  if (!storage) return { ok: false, state: initial, canPersist: false, warning: '浏览器本地存储不可用，练习进度不会持久保存。' }
  try {
    const raw = storage.getItem(SHAPE_PRACTICE_STORAGE_KEY)
    if (!raw) return { ok: true, state: initial, canPersist: true }
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || parsed.version !== 1 || parsed.datasetId !== dataset.id || !isRecord(parsed.questions)) {
      return { ok: false, state: initial, canPersist: false, warning: '已保存的练习进度与当前题库不匹配，已暂停自动保存以保护原有记录。' }
    }
    return { ok: true, state: mergeShapePracticeStore(dataset, parsed), canPersist: true }
  } catch {
    return { ok: false, state: initial, canPersist: false, warning: '读取练习进度失败，已暂停自动保存以保护原有记录。' }
  }
}

export function saveShapePracticeStore(state: ShapePracticeStore, storage: Storage | null = browserStorage()): { ok: boolean; warning?: string } {
  if (!storage) return { ok: false, warning: '浏览器本地存储不可用，练习进度不会持久保存。' }
  try {
    storage.setItem(SHAPE_PRACTICE_STORAGE_KEY, JSON.stringify(state))
    return { ok: true }
  } catch {
    return { ok: false, warning: '保存练习进度失败，请检查浏览器存储空间或权限。' }
  }
}

export function getShapePracticeVisibleSlice(question: ShapePracticeQuestion, cursor: number, windowSize = DEFAULT_SHAPE_PRACTICE_WINDOW): ShapePracticeVisibleSlice {
  const endIndex = questionCursor(question, cursor)
  const safeWindow = Math.max(1, Math.trunc(windowSize))
  const startIndex = Math.max(0, endIndex - safeWindow + 1)
  return {
    bars: question.bars.slice(startIndex, endIndex + 1),
    ema20: question.ema20.slice(startIndex, endIndex + 1),
    startIndex,
    endIndex,
  }
}

export const visibleShapePracticeSlice = getShapePracticeVisibleSlice
export const getVisibleShapePracticeBars = (question: ShapePracticeQuestion, cursor: number, windowSize = DEFAULT_SHAPE_PRACTICE_WINDOW) => getShapePracticeVisibleSlice(question, cursor, windowSize).bars

export function calculateShapePracticeQuantity(entryPrice: number, stopLoss: number, riskUsd = SHAPE_PRACTICE_RISK_USD) {
  if (!finiteNumber(entryPrice) || !finiteNumber(stopLoss) || !finiteNumber(riskUsd) || riskUsd <= 0) return null
  const distance = Math.abs(entryPrice - stopLoss)
  return distance > 0 ? riskUsd / distance : null
}

export const calculateShapePracticeSize = calculateShapePracticeQuantity

export function queueShapePracticeOrder(question: ShapePracticeQuestion, progress: ShapePracticeProgress, side: ShapePracticeSide, stopLoss: number, takeProfit?: number): ShapePracticeActionResult {
  if (progress.status === 'completed') return fail(progress, '本题已经结束，不能再次开仓。')
  if (progress.result) return fail(progress, '本题已完成一次交易，初版练习不再追加交易。')
  if (progress.position) return fail(progress, '当前已有持仓，请先手动平仓或完成本题。')
  if (progress.pendingOrder) return fail(progress, '当前已有等待成交的订单。')
  const cursor = activeQuestionCursor(question, progress.cursor)
  if (cursor >= question.bars.length - 1) return fail(progress, '当前已经是最后一根已知 K 线，没有下一根开盘可成交。')
  const close = question.bars[cursor]?.close
  if (!finiteNumber(stopLoss) || !sideStopIsValid(side, close, stopLoss)) return fail(progress, `${entryDirectionLabel(side)}的止损方向无效：请把止损放在当前收盘价${side === 'long' ? '下方' : '上方'}。`)
  if (takeProfit !== undefined && (!finiteNumber(takeProfit) || !sideTakeProfitIsValid(side, close, takeProfit))) return fail(progress, `${entryDirectionLabel(side)}的止盈方向无效：请把止盈放在当前收盘价${side === 'long' ? '上方' : '下方'}。`)
  const state: ShapePracticeProgress = {
    ...copyProgress(progress, question),
    cursor,
    pendingOrder: {
      side,
      stopLoss,
      ...(takeProfit !== undefined ? { takeProfit } : {}),
      requestedAtIndex: cursor,
      requestedAtTime: question.bars[cursor].time,
    },
    notice: `${entryDirectionLabel(side)}已挂单：将在下一根 K 线开盘成交；固定止损风险 $${SHAPE_PRACTICE_RISK_USD}。`,
    updatedAt: Date.now(),
  }
  return action(state, true, state.notice)
}

export const requestShapePracticeEntry = queueShapePracticeOrder
export const submitShapePracticeOrder = queueShapePracticeOrder

export function cancelShapePracticePendingOrder(question: ShapePracticeQuestion, progress: ShapePracticeProgress): ShapePracticeActionResult {
  if (!progress.pendingOrder) return fail(progress, '当前没有等待成交的订单。')
  const state = { ...copyProgress(progress, question), pendingOrder: null, notice: '等待成交的订单已取消。', updatedAt: Date.now() }
  return action(state, true, state.notice)
}

export function requestShapePracticeManualClose(question: ShapePracticeQuestion, progress: ShapePracticeProgress): ShapePracticeActionResult {
  if (!progress.position) return fail(progress, '当前没有可平仓的持仓。')
  if (progress.position.manualCloseRequestedAtIndex !== undefined) return fail(progress, '手动平仓已经排队，将在下一根开盘执行。')
  if (progress.cursor >= question.bars.length - 1) return fail(progress, '没有下一根 K 线开盘可执行手动平仓，请结束本题按当前已知收盘价结算。')
  const state: ShapePracticeProgress = {
    ...copyProgress(progress, question),
    position: { ...progress.position, manualCloseRequestedAtIndex: activeQuestionCursor(question, progress.cursor) },
    notice: '手动平仓已排队：将在下一根 K 线开盘执行。',
    updatedAt: Date.now(),
  }
  return action(state, true, state.notice)
}

export function advanceShapePractice(question: ShapePracticeQuestion, progress: ShapePracticeProgress): ShapePracticeActionResult {
  const cursor = activeQuestionCursor(question, progress.cursor)
  if (cursor >= question.bars.length - 1) return fail(progress, '已经到达最后一根已知 K 线。')
  const nextIndex = cursor + 1
  const nextBar = question.bars[nextIndex]
  if (progress.result || progress.status === 'completed') {
    const state: ShapePracticeProgress = {
      ...copyProgress(progress, question),
      cursor: nextIndex,
      notice: '本题交易已经结束，当前仅继续查看后续已知走势。',
      updatedAt: Date.now(),
    }
    return action(state, true, state.notice)
  }
  let position = progress.position ? { ...progress.position } : null
  let pendingOrder = progress.pendingOrder ? { ...progress.pendingOrder } : null
  let result: ShapePracticeTradeResult | null = null
  let notice = ''

  if (pendingOrder) {
    if (pendingOrder.requestedAtIndex !== cursor) {
      pendingOrder = null
      notice = '等待成交的订单因进度不连续已取消。'
    } else {
      const execution = executePendingOrder(pendingOrder, nextBar, nextIndex)
      pendingOrder = null
      position = execution.position
      notice = execution.message
    }
  }

  if (position) {
    // A queued manual close is an opening-price action. First account for a
    // protective gap at that open; when neither protective level gaps through,
    // close immediately and never inspect this bar's later high/low.
    const stopAtOpen = position.side === 'long' ? nextBar.open <= position.stopLoss : nextBar.open >= position.stopLoss
    const takeProfitAtOpen = position.takeProfit !== undefined
      && (position.side === 'long' ? nextBar.open >= position.takeProfit : nextBar.open <= position.takeProfit)
    const manualCloseDue = position.manualCloseRequestedAtIndex !== undefined && position.manualCloseRequestedAtIndex <= cursor
    if (stopAtOpen) {
      result = resultFromPosition(position, nextBar, nextBar.open, 'stop-loss', false, nextIndex)
      notice = `${notice ? `${notice} ` : ''}止损触发（开盘跳空，按开盘价），本笔 ${result.rMultiple.toFixed(2)}R。`
      position = null
    } else if (takeProfitAtOpen) {
      result = resultFromPosition(position, nextBar, nextBar.open, 'take-profit', false, nextIndex)
      notice = `${notice ? `${notice} ` : ''}止盈触发（开盘跳空，按开盘价），本笔 ${result.rMultiple.toFixed(2)}R。`
      position = null
    } else if (manualCloseDue) {
      result = resultFromPosition(position, nextBar, nextBar.open, 'manual-close', false, nextIndex)
      notice = `${notice ? `${notice} ` : ''}手动平仓已按下一根开盘价 ${roundDisplay(nextBar.open)} 执行，本笔 ${result.rMultiple.toFixed(2)}R。`
      position = null
    } else {
      // With no opening gap or queued close, use the complete known range.
      // If both levels are touched in one candle, stop is deliberately first.
      const stop = stopHit(position.side, nextBar, position.stopLoss)
      const takeProfit = position.takeProfit === undefined ? null : takeProfitHit(position.side, nextBar, position.takeProfit)
      if (stop) {
        result = resultFromPosition(position, nextBar, stop.price, 'stop-loss', false, nextIndex)
        notice = `${notice ? `${notice} ` : ''}止损触发，本笔 ${result.rMultiple.toFixed(2)}R。`
        position = null
      } else if (takeProfit) {
        result = resultFromPosition(position, nextBar, takeProfit.price, 'take-profit', false, nextIndex)
        notice = `${notice ? `${notice} ` : ''}止盈触发，本笔 ${result.rMultiple.toFixed(2)}R。`
        position = null
      }
    }
  }

  const state: ShapePracticeProgress = {
    ...copyProgress(progress, question),
    cursor: nextIndex,
    pendingOrder,
    position,
    result,
    status: result ? 'completed' : 'active',
    ...(notice ? { notice } : {}),
    updatedAt: Date.now(),
  }
  return action(state, true, state.notice)
}

export const nextShapePracticeBar = advanceShapePractice
export const stepShapePractice = advanceShapePractice

export function finishShapePracticeQuestion(question: ShapePracticeQuestion, progress: ShapePracticeProgress): ShapePracticeActionResult {
  if (progress.status === 'completed') return fail(progress, '本题已经结束。')
  const cursor = activeQuestionCursor(question, progress.cursor)
  const bar = question.bars[cursor]
  let result = progress.result ? { ...progress.result } : null
  let notice = '本题已完成。'
  if (progress.position) {
    result = resultFromPosition(progress.position, bar, bar.close, 'finished', true, cursor)
    notice = `本题结束：未再等待下一根，持仓按当前已知收盘价 ${roundDisplay(bar.close)} 结算，${result.rMultiple.toFixed(2)}R（强制结束）。`
  } else if (progress.pendingOrder) {
    notice = '本题结束：未成交挂单已取消，没有产生交易。'
  } else if (!result) {
    notice = '本题已完成：本题选择观察，没有产生交易。'
  }
  const state: ShapePracticeProgress = {
    ...copyProgress(progress, question),
    cursor,
    pendingOrder: null,
    position: null,
    result,
    status: 'completed',
    notice,
    updatedAt: Date.now(),
  }
  return action(state, true, notice)
}

export const completeShapePracticeQuestion = finishShapePracticeQuestion

export function shapePracticeMark(position: ShapePracticePosition, price: number) {
  const points = position.side === 'long' ? price - position.entryPrice : position.entryPrice - price
  const pnlUsd = points * position.quantity
  return { pnlUsd, rMultiple: position.riskUsd > 0 ? pnlUsd / position.riskUsd : 0 }
}

export interface ShapePracticeScore {
  completed: number
  total: number
  traded: number
  wins: number
  losses: number
  netPnlUsd: number
  netR: number
  winRate: number | null
}

export function summarizeShapePracticeScore(states: readonly ShapePracticeProgress[], total = states.length): ShapePracticeScore {
  const completedStates = states.filter((state) => state.status === 'completed')
  const results = completedStates.flatMap((state) => state.result ? [state.result] : [])
  const wins = results.filter((result) => result.pnlUsd > 0).length
  const losses = results.filter((result) => result.pnlUsd < 0).length
  return {
    completed: completedStates.length,
    total,
    traded: results.length,
    wins,
    losses,
    netPnlUsd: results.reduce((sum, result) => sum + result.pnlUsd, 0),
    netR: results.reduce((sum, result) => sum + result.rMultiple, 0),
    winRate: results.length > 0 ? wins / results.length * 100 : null,
  }
}

export function formatShapePracticeTime(epoch: number) {
  const milliseconds = Math.abs(epoch) > 1_000_000_000_000 ? epoch : epoch * 1000
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(milliseconds))
}
