import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const STORAGE_KEY = 'kline-studio-floating-card-order-v1'
const card = () => ({ style: { zIndex: '' } }) as HTMLElement
const level = (element: HTMLElement) => Number(element.style.zIndex)

function storage(values = new Map<string, string>()) {
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
}

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('localStorage', storage())
})
afterEach(() => vi.unstubAllGlobals())

describe('floating card stacking', () => {
  it('places each new card above the already mounted cards', async () => {
    const { registerFloatingCard } = await import('./floatingCards')
    const first = card()
    const second = card()
    const third = card()
    registerFloatingCard('first', first)
    registerFloatingCard('second', second)
    registerFloatingCard('third', third)
    expect(level(first)).toBeLessThan(level(second))
    expect(level(second)).toBeLessThan(level(third))
    for (const element of [first, second, third]) {
      expect(level(element)).toBeGreaterThanOrEqual(70)
      expect(level(element)).toBeLessThanOrEqual(79)
    }
  })

  it('synchronously promotes alternating activations without growing z-index', async () => {
    const { registerFloatingCard, bringFloatingCardToFront } = await import('./floatingCards')
    const first = card()
    const second = card()
    const third = card()
    registerFloatingCard('first', first)
    registerFloatingCard('second', second)
    registerFloatingCard('third', third)
    for (let index = 0; index < 300; index += 1) {
      const active = index % 2 === 0 ? first : second
      const other = active === first ? second : first
      bringFloatingCardToFront(active)
      expect(level(active)).toBeGreaterThan(level(other))
      expect(level(active)).toBeGreaterThan(level(third))
      for (const element of [first, second, third]) {
        expect(level(element)).toBeGreaterThanOrEqual(70)
        expect(level(element)).toBeLessThanOrEqual(79)
      }
    }
  })

  it('restores saved ID order across a reload regardless of mount order', async () => {
    const saved = storage()
    vi.stubGlobal('localStorage', saved)
    const initial = await import('./floatingCards')
    const first = card()
    const second = card()
    const third = card()
    initial.registerFloatingCard('first', first)
    initial.registerFloatingCard('second', second)
    initial.registerFloatingCard('third', third)
    initial.bringFloatingCardToFront(first)
    expect(saved.values.has(STORAGE_KEY)).toBe(true)

    vi.resetModules()
    const restored = await import('./floatingCards')
    const firstReloaded = card()
    const secondReloaded = card()
    const thirdReloaded = card()
    restored.registerFloatingCard('first', firstReloaded)
    restored.registerFloatingCard('third', thirdReloaded)
    restored.registerFloatingCard('second', secondReloaded)
    expect(level(secondReloaded)).toBeLessThan(level(thirdReloaded))
    expect(level(thirdReloaded)).toBeLessThan(level(firstReloaded))

    const newCard = card()
    restored.registerFloatingCard('new', newCard)
    expect(level(newCard)).toBeGreaterThan(level(firstReloaded))
  })

  it('stops touching unregistered nodes and restores their saved ID rank on remount', async () => {
    const { registerFloatingCard, bringFloatingCardToFront } = await import('./floatingCards')
    const first = card()
    const second = card()
    const third = card()
    registerFloatingCard('first', first)
    const unregisterSecond = registerFloatingCard('second', second)
    registerFloatingCard('third', third)
    unregisterSecond()
    second.style.zIndex = 'removed'
    bringFloatingCardToFront(first)
    bringFloatingCardToFront(second)
    expect(second.style.zIndex).toBe('removed')
    expect(level(first)).toBeGreaterThan(level(third))

    const replacement = card()
    registerFloatingCard('second', replacement)
    expect(level(replacement)).toBeLessThan(level(third))
    expect(level(third)).toBeLessThan(level(first))
    expect(second.style.zIndex).toBe('removed')
  })

  it('raises a known editor by ID before remount and persists the reopened order', async () => {
    const saved = storage()
    vi.stubGlobal('localStorage', saved)
    const { registerFloatingCard, bringFloatingCardToFront, bringFloatingCardIdToFront } = await import('./floatingCards')
    const timeline = card()
    const editor = card()
    registerFloatingCard('timeline', timeline)
    const unregisterEditor = registerFloatingCard('comment-editor', editor)
    unregisterEditor()
    bringFloatingCardToFront(timeline)
    expect(JSON.parse(saved.getItem(STORAGE_KEY)!)).toEqual(['comment-editor', 'timeline'])

    bringFloatingCardIdToFront('comment-editor')
    const reopenedEditor = card()
    registerFloatingCard('comment-editor', reopenedEditor)
    expect(level(reopenedEditor)).toBeGreaterThan(level(timeline))
    expect(JSON.parse(saved.getItem(STORAGE_KEY)!)).toEqual(['timeline', 'comment-editor'])

    vi.resetModules()
    const restored = await import('./floatingCards')
    const restoredEditor = card()
    const restoredTimeline = card()
    restored.registerFloatingCard('comment-editor', restoredEditor)
    restored.registerFloatingCard('timeline', restoredTimeline)
    expect(level(restoredEditor)).toBeGreaterThan(level(restoredTimeline))
    expect(JSON.parse(saved.getItem(STORAGE_KEY)!)).toEqual(['timeline', 'comment-editor'])
  })

  it('keeps distinct IDs independent even when they share prefixes', async () => {
    const { registerFloatingCard, bringFloatingCardToFront } = await import('./floatingCards')
    const chartOne = card()
    const chartTwo = card()
    const chartOneTools = card()
    registerFloatingCard('chart:1', chartOne)
    registerFloatingCard('chart:2', chartTwo)
    registerFloatingCard('chart:1:tools', chartOneTools)
    bringFloatingCardToFront(chartOne)
    expect(level(chartTwo)).toBeLessThan(level(chartOneTools))
    expect(level(chartOneTools)).toBeLessThan(level(chartOne))
    bringFloatingCardToFront(chartTwo)
    expect(level(chartOneTools)).toBeLessThan(level(chartOne))
    expect(level(chartOne)).toBeLessThan(level(chartTwo))
  })

  it.each(['{broken', '{}', 'null', '42', '[null,1,{},"first","first"]'])('tolerates malformed saved order %s', async (value) => {
    vi.stubGlobal('localStorage', storage(new Map([[STORAGE_KEY, value]])))
    const { registerFloatingCard, bringFloatingCardToFront } = await import('./floatingCards')
    const first = card()
    const second = card()
    expect(() => {
      registerFloatingCard('first', first)
      registerFloatingCard('second', second)
      bringFloatingCardToFront(first)
    }).not.toThrow()
    expect(level(first)).toBeGreaterThan(level(second))
  })

  it.each(['absent', 'blocked', 'full'])('works when localStorage is %s', async (mode) => {
    vi.stubGlobal('localStorage', mode === 'absent' ? undefined : {
      getItem: () => {
        if (mode === 'blocked') throw new Error('access denied')
        return null
      },
      setItem: () => { throw new Error('quota exceeded') },
    })
    const { registerFloatingCard, bringFloatingCardToFront } = await import('./floatingCards')
    const first = card()
    const second = card()
    expect(() => {
      const unregisterFirst = registerFloatingCard('first', first)
      registerFloatingCard('second', second)
      bringFloatingCardToFront(first)
      expect(level(first)).toBeGreaterThan(level(second))
      unregisterFirst()
    }).not.toThrow()
  })
})
