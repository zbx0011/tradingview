export const DECISION_REPLAY_FAVORITES_STORAGE_KEY = 'kline-studio-decision-replay-favorites-v1'

export type DecisionReplayFavoriteKind = 'trade' | 'session'

export function decisionReplayFavoriteKey(kind: DecisionReplayFavoriteKind, id: string) {
  return `${kind}:${id}`
}

export function decisionReplaySessionHasFavorite(
  favorites: readonly string[],
  sessionId: string,
  candidateKeys: readonly string[],
) {
  return favorites.includes(decisionReplayFavoriteKey('session', sessionId))
    || candidateKeys.some((key) => favorites.includes(decisionReplayFavoriteKey('trade', key)))
}

export function normalizeDecisionReplayFavorites(value: unknown) {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0)))
}

export function parseDecisionReplayFavorites(raw: string | null) {
  if (!raw) return []
  try {
    return normalizeDecisionReplayFavorites(JSON.parse(raw))
  } catch {
    return []
  }
}

export function loadDecisionReplayFavorites() {
  try {
    return parseDecisionReplayFavorites(localStorage.getItem(DECISION_REPLAY_FAVORITES_STORAGE_KEY))
  } catch {
    return []
  }
}

export function saveDecisionReplayFavorites(favorites: string[]) {
  try {
    localStorage.setItem(DECISION_REPLAY_FAVORITES_STORAGE_KEY, JSON.stringify(normalizeDecisionReplayFavorites(favorites)))
  } catch {
    // A restricted browser context should not prevent the replay UI from working.
  }
}

export function toggleDecisionReplayFavorite(favorites: string[], key: string) {
  if (!key) return favorites
  return favorites.includes(key)
    ? favorites.filter((item) => item !== key)
    : [...favorites, key]
}
