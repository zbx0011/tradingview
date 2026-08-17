import { ALL_DRAWING_TOOLS } from './toolCatalog'

export const FAVORITE_TOOLS_KEY = 'kline-studio-favorite-tools-v1'

export const DEFAULT_FAVORITE_TOOLS = [
  'arrow-line', 'text', 'horizontal', 'vertical', 'rectangle', 'arrow-up', 'parallel-channel', 'short-position',
]

const knownToolIds = new Set(ALL_DRAWING_TOOLS.map((tool) => tool.id))

export function normalizeFavoriteTools(value: unknown) {
  if (!Array.isArray(value)) return [...DEFAULT_FAVORITE_TOOLS]
  return Array.from(new Set(value.filter((item): item is string => typeof item === 'string' && knownToolIds.has(item))))
}

export function loadFavoriteTools() {
  try {
    const saved = localStorage.getItem(FAVORITE_TOOLS_KEY)
    return saved === null ? [...DEFAULT_FAVORITE_TOOLS] : normalizeFavoriteTools(JSON.parse(saved))
  } catch {
    return [...DEFAULT_FAVORITE_TOOLS]
  }
}

export function saveFavoriteTools(favorites: string[]) {
  localStorage.setItem(FAVORITE_TOOLS_KEY, JSON.stringify(normalizeFavoriteTools(favorites)))
}

export function toggleFavoriteTool(favorites: string[], id: string) {
  if (!knownToolIds.has(id)) return favorites
  return favorites.includes(id) ? favorites.filter((item) => item !== id) : [...favorites, id]
}
