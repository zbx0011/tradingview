import { describe, expect, it } from 'vitest'
import { DEFAULT_FAVORITE_TOOLS, normalizeFavoriteTools, toggleFavoriteTool } from './favoriteTools'

describe('favorite drawing tools', () => {
  it('uses the reference quick tools when no saved value exists', () => {
    expect(normalizeFavoriteTools(null)).toEqual(DEFAULT_FAVORITE_TOOLS)
  })

  it('removes duplicates and unknown tool ids from saved favorites', () => {
    expect(normalizeFavoriteTools(['long-position', 'long-position', 'missing', 7])).toEqual(['long-position'])
  })

  it('adds and removes a favorite without changing the other tools', () => {
    expect(toggleFavoriteTool(['short-position'], 'long-position')).toEqual(['short-position', 'long-position'])
    expect(toggleFavoriteTool(['short-position', 'long-position'], 'short-position')).toEqual(['long-position'])
  })
})
