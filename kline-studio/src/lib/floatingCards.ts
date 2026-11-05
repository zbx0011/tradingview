const STORAGE_KEY = 'kline-studio-floating-card-order-v1'
const cards = new Map<HTMLElement, string>()
let order: string[] | null = null

function savedOrder() {
  if (order !== null) return order
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    order = Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string'))].slice(-64) : []
  } catch { order = [] }
  return order
}

function syncLayers() {
  const ids = savedOrder()
  const mounted = [...cards].sort((a, b) => ids.indexOf(a[1]) - ids.indexOf(b[1]))
  mounted.forEach(([element], index) => {
    // Keep floating windows below modal backdrops; never grow a global z-index forever.
    element.style.zIndex = String(70 + Math.floor(9 * index / Math.max(1, mounted.length - 1)))
  })
}

function remember() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(savedOrder())) } catch { /* Layering still works without storage. */ }
}

export function registerFloatingCard(id: string, element: HTMLElement) {
  const ids = savedOrder()
  cards.set(element, id)
  if (!ids.includes(id)) { order = [...ids, id].slice(-64); remember() }
  syncLayers()
  return () => { cards.delete(element); syncLayers() }
}

export function bringFloatingCardToFront(element: HTMLElement) {
  const id = cards.get(element)
  if (id === undefined) return
  bringFloatingCardIdToFront(id)
}

/** Opening an existing editor must raise it before its autofocus/layout commit. */
export function bringFloatingCardIdToFront(id: string) {
  order = [...savedOrder().filter(value => value !== id), id].slice(-64)
  syncLayers()
  remember()
}
