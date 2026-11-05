import { useLayoutEffect, useState, type SetStateAction, type Dispatch } from 'react'

const PREFIX = 'kline-studio-page-state-v1:'
export function loadPageValue<T>(name: string, fallback: T): T {
  if (typeof localStorage === 'undefined') return fallback
  try {
    const raw = localStorage.getItem(PREFIX + name)
    if (raw === null) return fallback
    const value = JSON.parse(raw, (_key, item) => item && typeof item === 'object' && Array.isArray(item.__klineSet) ? new Set(item.__klineSet) : item)
    if (fallback !== null && (typeof value !== typeof fallback || Array.isArray(value) !== Array.isArray(fallback))) return fallback
    return value as T
  } catch { return fallback }
}
export function savePageValue(name: string, value: unknown) {
  try { localStorage.setItem(PREFIX + name, JSON.stringify(value, (_key, item) => item instanceof Set ? { __klineSet: [...item] } : item)) } catch { /* Storage may be unavailable or full. */ }
}
/** Save committed UI state immediately, including just before a tab is closed. */
export function usePageState<T>(name: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => loadPageValue(name, typeof initial === 'function' ? (initial as () => T)() : initial))
  useLayoutEffect(() => { savePageValue(name, value) }, [name, value])
  return [value, setValue]
}
