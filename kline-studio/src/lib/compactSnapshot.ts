import type { Candle } from './market'

/**
 * Compact binary 1-minute history ("KLB1"), used for the large NQ snapshot: the JSON file is ~106 MB and loads slowly
 * from a local disk; this format plus gzip is ~10 MB. Prices must sit on a tick grid of 1/`scale` (NQ: scale 4).
 *
 * Layout, little-endian, 28-byte header then six columns of `count` 32-bit values:
 *   'KLB1' · count u32 · scale u32 · first time f64 (seconds) · first open f64 (ticks)
 *   time step u32 (0 for the first bar) · open − previous close i32 · close − open i32 ·
 *   high − max(open, close) u32 · min(open, close) − low u32 · volume u32
 * The file on disk is that buffer gzip-compressed (see scripts/build-compact-snapshot.mjs).
 */
const MAGIC = 0x31424c4b // 'KLB1'
const HEADER = 28

export function decodeCompactSnapshot(buffer: ArrayBuffer): Candle[] {
  const view = new DataView(buffer)
  if (buffer.byteLength < HEADER || view.getUint32(0, true) !== MAGIC) throw new Error('紧凑历史数据格式无效')
  const count = view.getUint32(4, true), scale = view.getUint32(8, true)
  if (!count || !scale || buffer.byteLength !== HEADER + count * 24) throw new Error('紧凑历史数据长度不对')
  let time = view.getFloat64(12, true), close = view.getFloat64(20, true)
  const column = (k: number) => HEADER + k * count * 4
  const step = new Uint32Array(buffer, column(0), count)
  const openDelta = new Int32Array(buffer, column(1), count)
  const body = new Int32Array(buffer, column(2), count)
  const upper = new Uint32Array(buffer, column(3), count)
  const lower = new Uint32Array(buffer, column(4), count)
  const volume = new Uint32Array(buffer, column(5), count)
  const bars: Candle[] = new Array(count)
  for (let i = 0; i < count; i += 1) {
    time += step[i]
    const open = close + openDelta[i]
    close = open + body[i]
    const high = Math.max(open, close) + upper[i], low = Math.min(open, close) - lower[i]
    bars[i] = { time, open: open / scale, high: high / scale, low: low / scale, close: close / scale, volume: volume[i] }
  }
  return bars
}

/** Inverse of `decodeCompactSnapshot` (tests and tooling; the build script has its own Node copy). */
export function encodeCompactSnapshot(bars: readonly Candle[], scale: number): ArrayBuffer {
  const count = bars.length
  const buffer = new ArrayBuffer(HEADER + count * 24)
  const view = new DataView(buffer)
  view.setUint32(0, MAGIC, true); view.setUint32(4, count, true); view.setUint32(8, scale, true)
  const ticks = (price: number) => Math.round(price * scale)
  view.setFloat64(12, bars[0]?.time ?? 0, true); view.setFloat64(20, bars[0] ? ticks(bars[0].open) : 0, true)
  const column = (k: number) => HEADER + k * count * 4
  const step = new Uint32Array(buffer, column(0), count), openDelta = new Int32Array(buffer, column(1), count)
  const body = new Int32Array(buffer, column(2), count), upper = new Uint32Array(buffer, column(3), count)
  const lower = new Uint32Array(buffer, column(4), count), volume = new Uint32Array(buffer, column(5), count)
  let previousClose = bars[0] ? ticks(bars[0].open) : 0, previousTime = bars[0]?.time ?? 0
  bars.forEach((bar, i) => {
    const open = ticks(bar.open), close = ticks(bar.close)
    step[i] = bar.time - previousTime; openDelta[i] = open - previousClose; body[i] = close - open
    upper[i] = ticks(bar.high) - Math.max(open, close); lower[i] = Math.min(open, close) - ticks(bar.low)
    volume[i] = Math.round(bar.volume)
    previousClose = close; previousTime = bar.time
  })
  return buffer
}

/** Gunzip when the bytes are still gzip (a server may already have decoded them via Content-Encoding). */
export async function gunzipIfNeeded(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  const head = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength))
  if (head[0] !== 0x1f || head[1] !== 0x8b) return bytes
  if (typeof DecompressionStream === 'undefined') throw new Error('浏览器不支持解压历史数据')
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
}
