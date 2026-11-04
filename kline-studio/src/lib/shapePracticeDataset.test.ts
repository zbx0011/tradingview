import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const data = JSON.parse(readFileSync(resolve('public/data/shape-practice/xauusd-5m-strong22.json'), 'utf8')) as {
  sourceSha256: string
  questions: Array<{ id: string; startIndex: number; signalTime: number; ema20: number[];
    bars: Array<{ time: number; open: number; high: number; low: number; close: number }> }>
}

describe('frozen strong-22 practice dataset', () => {
  it('imports exactly the accepted IDs with the original source hash', () => {
    expect(data.sourceSha256).toBe('7782f611e355207c378cd77e5eb8aeecf0157f75ae4093676aa1b392b30e117e')
    expect(data.questions.map(q => q.id)).toEqual(['M01','M02','M05','M06','M11','M14','M15','M17','M18','M20','M24','M25','M27','M28','M29','M30','M31','M36','M37','M38','M48','M49'])
  })
  it('has causal EMA20, correct starting candles and forward practice data in every question', () => {
    for (const q of data.questions) {
      expect(q.startIndex).toBeGreaterThanOrEqual(250)
      expect(q.bars[q.startIndex].time).toBe(q.signalTime)
      expect(q.bars.length - q.startIndex - 1).toBe(96)
      expect(q.ema20.length).toBe(q.bars.length)
      for (let i = 1; i < q.bars.length; i++) {
        expect(q.bars[i].time).toBeGreaterThan(q.bars[i-1].time)
        expect(q.ema20[i]).toBeCloseTo(q.bars[i].close * 2/21 + q.ema20[i-1]*19/21, 8)
        expect(q.bars[i].high).toBeGreaterThanOrEqual(Math.max(q.bars[i].open,q.bars[i].close))
        expect(q.bars[i].low).toBeLessThanOrEqual(Math.min(q.bars[i].open,q.bars[i].close))
      }
    }
  })
  it('does not ship research verdicts, direction hints or outcome statistics to the practice UI', () => {
    for (const q of data.questions) {
      expect(Object.keys(q).sort()).toEqual(['bars','ema20','id','signalTime','startIndex'])
    }
  })
})
