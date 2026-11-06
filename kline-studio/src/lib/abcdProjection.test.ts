import { describe, expect, it } from 'vitest'
import { projectAbCd } from './abcdProjection'
import type { DrawingPoint } from './drawings'
import { normalizeFavoriteTools, toggleFavoriteTool } from './favoriteTools'
import { ALL_DRAWING_TOOLS, getTool, getToolGroupForTool } from './toolCatalog'

describe('AB=CD equal-leg projection', () => {
  it.each([
    [{ x: 1, y: 8, price: 100, time: 10 }, { x: 3, y: 2, price: 160, time: 20 }, { x: 4, y: 5, price: 130, time: 25 }, { x: 6, y: -1, price: 190, time: 35 }],
    [{ x: 1, y: 2, price: 160, time: 10 }, { x: 3, y: 8, price: 100, time: 20 }, { x: 4, y: 5, price: 130, time: 25 }, { x: 6, y: 11, price: 70, time: 35 }],
    [{ x: 3, y: 2 }, { x: 1, y: 8 }, { x: 0, y: 5 }, { x: -2, y: 11 }],
    [{ x: -2.5, y: 1.25, price: -5.5 }, { x: -1.25, y: -2.5, price: -2.25 }, { x: 0.5, y: -1.25, price: -3.5 }, { x: 1.75, y: -5, price: -0.25 }],
  ])('adds the signed AB displacement to C', (a, b, c, d) => {
    expect(projectAbCd([a, b, c])).toEqual(d)
  })

  it('uses raw prices rather than ratios or log-space y distances', () => {
    const d = projectAbCd([{ x: 0, y: 0, price: 100 }, { x: 1, y: -10, price: 200 }, { x: 2, y: -5, price: 150 }])
    expect(d).toEqual({ x: 3, y: -15, price: 250 })
  })

  it('omits incomplete or nonfinite optional metadata independently', () => {
    expect(projectAbCd([{ x: 0, y: 0, price: 10, time: 0 }, { x: 1, y: 1, price: 20, time: 1 }, { x: 2, y: 0, time: 2 }])).toEqual({ x: 3, y: 1, time: 3 })
    expect(projectAbCd([{ x: 0, y: 0, price: 10, time: 0 }, { x: 1, y: 1, price: 20, time: Infinity }, { x: 2, y: 0, price: 15 }])).toEqual({ x: 3, y: 1, price: 25 })
  })

  it('rejects incomplete, invalid and zero-amplitude anchors', () => {
    expect(projectAbCd([])).toBeNull()
    expect(projectAbCd([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBeNull()
    for (const value of [NaN, Infinity, -Infinity]) {
      for (const index of [0, 1, 2]) {
        for (const coordinate of ['x', 'y'] as const) {
          const points = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }]
          points[index][coordinate] = value
          expect(projectAbCd(points)).toBeNull()
        }
      }
    }
    expect(projectAbCd([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 }])).toBeNull()
    expect(projectAbCd([{ x: 0, y: 0, price: 10 }, { x: 1, y: 1, price: 10 }, { x: 2, y: 0 }])).toBeNull()
  })

  it('rejects arithmetic overflow', () => {
    expect(projectAbCd([{ x: 0, y: 0 }, { x: Number.MAX_VALUE, y: 1 }, { x: Number.MAX_VALUE, y: 2 }])).toBeNull()
    expect(projectAbCd([{ x: 0, y: 0, price: 1 }, { x: 1, y: 1, price: Number.MAX_VALUE }, { x: 2, y: 2, price: Number.MAX_VALUE }])).toBeNull()
    expect(projectAbCd([{ x: 0, y: 0, time: 0 }, { x: 1, y: 1, time: Number.MAX_VALUE }, { x: 2, y: 2, time: Number.MAX_VALUE }])).toBeNull()
  })

  it('does not mutate stored anchors and derives D afresh after an anchor edit', () => {
    const points: DrawingPoint[] = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }]
    const original = structuredClone(points)
    const d = projectAbCd(points)
    expect(points).toEqual(original)
    expect(points).toHaveLength(3)
    expect(d).not.toBe(points[2])
    points[1] = { x: 2, y: 3 }
    expect(projectAbCd(points)).toEqual({ x: 4, y: 3 })
    expect(d).toEqual({ x: 3, y: 1 })
  })

  it('uses only A, B and C when extra points are supplied', () => {
    expect(projectAbCd([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }, { x: NaN, y: NaN }])).toEqual({ x: 3, y: 1 })
  })
})

describe('AB=CD drawing catalog', () => {
  it('exposes a separate harmonic projection tool without replacing manual ABCD', () => {
    expect(getTool('ab-equals-cd')).toMatchObject({ id: 'ab-equals-cd', label: 'AB=CD 等幅投射', group: 'patterns', section: '谐波形态', behavior: 'abc-projection', shortcut: 'Alt+D' })
    expect(getTool('abcd')).toMatchObject({ id: 'abcd', behavior: 'pattern' })
    expect(getToolGroupForTool('ab-equals-cd')?.id).toBe('patterns')
    expect(ALL_DRAWING_TOOLS.filter((tool) => tool.id === 'ab-equals-cd')).toHaveLength(1)
  })

  it('supports saved favorites and independent toggling alongside manual ABCD', () => {
    expect(normalizeFavoriteTools(['abcd', 'ab-equals-cd', 'ab-equals-cd'])).toEqual(['abcd', 'ab-equals-cd'])
    expect(toggleFavoriteTool(['abcd'], 'ab-equals-cd')).toEqual(['abcd', 'ab-equals-cd'])
    expect(toggleFavoriteTool(['abcd', 'ab-equals-cd'], 'ab-equals-cd')).toEqual(['abcd'])
  })
})
