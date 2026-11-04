import { useSyncExternalStore } from 'react'
import type { Candle } from './market'

// The crosshair candle changes on every pointer frame (and on every frame of a
// wheel zoom, because the bar under the cursor changes). Keeping it in App
// state re-rendered the whole workspace for each frame, so it lives in this tiny
// external store and only the legend/OHLC readouts subscribe to it.
let hoverCandle: Candle | null = null
const listeners = new Set<() => void>()

export function setHoverCandle(next: Candle | null) {
  if (next === hoverCandle) return
  if (next && hoverCandle && next.time === hoverCandle.time && next.close === hoverCandle.close
    && next.open === hoverCandle.open && next.high === hoverCandle.high && next.low === hoverCandle.low) return
  hoverCandle = next
  for (const listener of listeners) listener()
}

export function getHoverCandle() {
  return hoverCandle
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useHoverCandle() {
  return useSyncExternalStore(subscribe, getHoverCandle, getHoverCandle)
}
