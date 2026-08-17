import type { Candle } from './market'
import type { XauTradeMarker } from './tradeMarkers'

export type TradeReasonSection = 'entry' | 'exit'

export interface TradeCandleReference {
  index: number
  time: number
  candle: Candle
  sections: TradeReasonSection[]
}

interface ReferenceAnchor {
  index: number
  time: number
}

const MAX_BARE_INDEX_DISTANCE = 100
const NUMBER_TOKEN = /\d+(?:\.\d+)?/g

function isExplicitIndexPrefix(text: string, offset: number) {
  return /(?:idx|index|bar|k(?:线)?)\s*=?\s*$/i.test(text.slice(Math.max(0, offset - 12), offset))
}

function isEmbeddedIdentifier(text: string, tokenStart: number, tokenEnd: number) {
  return /[a-z_]/i.test(text[tokenStart - 1] ?? '') || /[a-z_]/i.test(text[tokenEnd] ?? '')
}

function isNonIndexCount(text: string, tokenStart: number, tokenEnd: number) {
  const suffix = text.slice(tokenEnd)
  if (/^\s*(?:美元|usd\b)/i.test(suffix)) return true
  if (/^\s*根/.test(suffix)) return !/第\s*$/.test(text.slice(Math.max(0, tokenStart - 4), tokenStart))
  return false
}

/**
 * Replay explanations contain both candle indexes and prices.  Decimal values
 * are always prices; bare integers are accepted only when they are close to a
 * known replay index.  Explicit `idx`/`index` references are always accepted.
 */
export function extractReasonCandleIndexes(text: string | undefined, anchorIndexes: readonly number[]): number[] {
  if (!text?.trim() || anchorIndexes.length === 0) return []
  const indexes = new Set<number>()
  for (const match of text.matchAll(NUMBER_TOKEN)) {
    const token = match[0]
    const offset = match.index ?? 0
    if (token.includes('.')) continue
    const index = Number(token)
    if (!Number.isSafeInteger(index) || index < 0) continue
    const explicit = isExplicitIndexPrefix(text, offset)
    if (!explicit && isEmbeddedIdentifier(text, offset, offset + token.length)) continue
    if (!explicit && isNonIndexCount(text, offset, offset + token.length)) continue
    if (!explicit && !anchorIndexes.some((anchor) => Math.abs(index - anchor) <= MAX_BARE_INDEX_DISTANCE)) continue
    indexes.add(index)
  }
  return [...indexes].sort((left, right) => left - right)
}

export function tradeReasonCandleIndexes(trade: XauTradeMarker): number[] {
  const indexes = new Set<number>(extractReasonCandleIndexes(trade.entry.reason, [trade.entry.signalIdx]))
  const exitAnchor = trade.exit.signalIdx ?? trade.exit.idx
  for (const index of extractReasonCandleIndexes(trade.exit.reason, [exitAnchor, trade.exit.idx])) indexes.add(index)
  return [...indexes].sort((left, right) => left - right)
}

function availableAnchors(trade: XauTradeMarker, data: readonly Candle[]): Array<ReferenceAnchor & { dataIndex: number }> {
  const anchors: ReferenceAnchor[] = [
    { index: trade.entry.signalIdx, time: trade.entry.signalTime },
    { index: trade.exit.idx, time: trade.exit.time },
  ]
  if (trade.exit.signalIdx !== undefined && trade.exit.signalTime !== undefined) {
    anchors.push({ index: trade.exit.signalIdx, time: trade.exit.signalTime })
  }
  const seen = new Set<string>()
  return anchors.flatMap((anchor) => {
    const key = `${anchor.index}:${anchor.time}`
    if (seen.has(key)) return []
    seen.add(key)
    const dataIndex = data.findIndex((candle) => candle.time === anchor.time)
    return dataIndex < 0 ? [] : [{ ...anchor, dataIndex }]
  })
}

export function resolveTradeCandleReferences(trade: XauTradeMarker, data: readonly Candle[]): TradeCandleReference[] {
  if (data.length === 0) return []
  const entryIndexes = extractReasonCandleIndexes(trade.entry.reason, [trade.entry.signalIdx])
  const exitAnchor = trade.exit.signalIdx ?? trade.exit.idx
  const exitIndexes = extractReasonCandleIndexes(trade.exit.reason, [exitAnchor, trade.exit.idx])
  const sectionByIndex = new Map<number, Set<TradeReasonSection>>()
  for (const index of entryIndexes) sectionByIndex.set(index, new Set(['entry']))
  for (const index of exitIndexes) {
    const sections = sectionByIndex.get(index) ?? new Set<TradeReasonSection>()
    sections.add('exit')
    sectionByIndex.set(index, sections)
  }
  const anchors = availableAnchors(trade, data)
  if (anchors.length === 0) return []

  const references: TradeCandleReference[] = []
  for (const [index, sections] of sectionByIndex) {
    const anchor = [...anchors].sort((left, right) => Math.abs(index - left.index) - Math.abs(index - right.index))[0]
    const candle = data[anchor.dataIndex + index - anchor.index]
    if (!candle) continue
    references.push({ index, time: candle.time, candle, sections: [...sections] })
  }
  return references.sort((left, right) => left.time - right.time || left.index - right.index)
}
