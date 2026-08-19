import { describe, expect, it } from 'vitest'
import {
  decisionReplayFavoriteKey, decisionReplaySessionHasFavorite, normalizeDecisionReplayFavorites, parseDecisionReplayFavorites,
  toggleDecisionReplayFavorite,
} from './decisionReplayFavorites'

describe('decision replay favorites', () => {
  it('builds namespaced keys for sessions and trades', () => {
    expect(decisionReplayFavoriteKey('session', 'session-1')).toBe('session:session-1')
    expect(decisionReplayFavoriteKey('trade', 'source:5m:12')).toBe('trade:source:5m:12')
  })

  it('normalizes persisted favorite keys', () => {
    expect(normalizeDecisionReplayFavorites(['trade:a', 'trade:a', '', 5, null])).toEqual(['trade:a'])
    expect(parseDecisionReplayFavorites('{bad json')).toEqual([])
  })

  it('toggles a favorite without changing the other keys', () => {
    expect(toggleDecisionReplayFavorite(['session:a'], 'trade:b')).toEqual(['session:a', 'trade:b'])
    expect(toggleDecisionReplayFavorite(['session:a', 'trade:b'], 'session:a')).toEqual(['trade:b'])
  })

  it('finds a history session favorited directly or through one of its trades', () => {
    expect(decisionReplaySessionHasFavorite(['session:session-1'], 'session-1', ['trade-1'])).toBe(true)
    expect(decisionReplaySessionHasFavorite(['trade:trade-1'], 'session-1', ['trade-1'])).toBe(true)
    expect(decisionReplaySessionHasFavorite(['trade:other'], 'session-1', ['trade-1'])).toBe(false)
  })
})
