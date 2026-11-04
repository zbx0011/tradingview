import { describe, expect, it } from 'vitest'
import {
  RESEARCH_SIGNAL_FORBIDDEN_FIELDS,
  researchSignalDatasetInfos,
  resolveResearchSignalMarker,
  toResearchSignalSeriesMarkers,
  validateResearchSignalPayload,
} from './researchSignalRegistry'

describe('research signal registry', () => {
  it('imports all 81 reviewed identities with distinct statuses and preserved directions', () => {
    const original = toResearchSignalSeriesMarkers('XAUUSD', '5m', ['pa-case-filter-old81-original'])
    const reviewed = toResearchSignalSeriesMarkers('XAUUSD', '5m', ['pa-case-filter-old81-reviewed'])
    expect(original).toHaveLength(81)
    expect(reviewed).toHaveLength(81)
    expect(reviewed.filter((m) => m.color === '#2dd4bf')).toHaveLength(55)
    expect(reviewed.filter((m) => m.color === '#8993a4')).toHaveLength(18)
    expect(reviewed.filter((m) => m.color === '#f4cf58')).toHaveLength(8)
    expect(reviewed.map((m) => [m.time, m.shape])).toEqual(original.map((m) => [m.time, m.shape]))
    const keep = toResearchSignalSeriesMarkers('XAUUSD', '5m', ['pa-case-filter-old81-reviewed'], undefined, false)
    expect(keep).toHaveLength(55)
    const selection = resolveResearchSignalMarker('XAUUSD', '5m', ['pa-case-filter-old81-reviewed'], reviewed[0].id)
    expect(selection?.signal.filterReview?.annotatedImage).toMatch(/^\/research\/old81\//)
    expect(Array.isArray(selection?.signal.filterReview?.cases)).toBe(true)
    const matched = reviewed.find((m) => String(m.id).endsWith('XAU-01-314'))!
    expect(resolveResearchSignalMarker('XAUUSD', '5m', ['pa-case-filter-old81-reviewed'], matched.id)?.signal.filterReview?.cases.length).toBeGreaterThan(0)
    expect(toResearchSignalSeriesMarkers('XAUUSD', '5m', ['pa-case-filter-old81-reviewed'], Number(reviewed[0].time))).toHaveLength(1)
  })
  it('exposes the two V6 review versions and the independent Al research layer', () => {
    expect(researchSignalDatasetInfos().map((layer) => layer.sourceId).sort()).toEqual([
      'al-swing-apprentice-v2-20260609', 'al-swing-apprentice-v2-fast', 'pa-case-filter-old81-original', 'pa-case-filter-old81-reviewed',
    ])
    expect(toResearchSignalSeriesMarkers('XAUUSD', '5m', ['v6-round2-baseline', 'v6-round2-candidate'])).toHaveLength(0)
    expect(toResearchSignalSeriesMarkers('XAUUSD', '5m', ['al-swing-apprentice-v2-fast'])).toHaveLength(23)
    expect(toResearchSignalSeriesMarkers('XAUUSD', '5m', ['al-swing-apprentice-v2-20260609'])).toHaveLength(33)
  })

  it('resolves a marker to frozen window bars and evidence without trade semantics', () => {
    const marker = toResearchSignalSeriesMarkers('XAUUSD', '5m', ['pa-case-filter-old81-original'])[0]
    const selection = resolveResearchSignalMarker('XAUUSD', '5m', ['pa-case-filter-old81-original'], marker.id)
    expect(selection).toMatchObject({ sourceId: 'pa-case-filter-old81-original', signal: { id: expect.any(String), side: expect.stringMatching(/long|short/) } })
    if (!selection) throw new Error('研究信号 marker 未解析')
    expect(selection?.window.bars).toHaveLength(576)
    expect(selection?.window.bars?.[selection.signal.idx].time).toBe(selection.signal.time)
    expect(selection?.signal.price).toBe(selection?.window.bars?.[selection.signal.idx].close)
    expect(Object.keys(selection?.signal ?? {}).some((key) => (RESEARCH_SIGNAL_FORBIDDEN_FIELDS as readonly string[]).includes(key))).toBe(false)
    expect(resolveResearchSignalMarker('XAUUSD', '5m', ['pa-case-filter-old81-reviewed'], marker.id)).toBeNull()
  })

  it('rejects an order-shaped research signal instead of weakening replay validation', () => {
    const payload = {
      schemaVersion: 1,
      sourceId: 'test-research',
      name: '测试研究层',
      symbol: 'XAUUSD',
      interval: '5m',
      reviewNote: '只读',
      windows: [{ id: 'W1', startTime: 1300, endTime: 1300, bars: [{ time: 1000, open: 1, high: 2, low: 1, close: 1.5, volume: 1 }, { time: 1300, open: 1.5, high: 3, low: 1.4, close: 2, volume: 1 }] }],
      signals: [{ id: 's1', windowId: 'W1', idx: 1, time: 1300, side: 'long', reason: '观察', context: { marketState: '结构' }, evidenceIndices: [1], reviewNote: '待复核', entryPrice: 2 }],
    }
    expect(() => validateResearchSignalPayload(payload, 'test')).toThrow(/交易字段 entryPrice/)
  })
})
