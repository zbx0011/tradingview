import { describe, expect, it } from 'vitest'
import {
  replaySignalDatasetInfos, resolveReplaySignalMarker, toReplaySignalRangeSpecs, toReplaySignalSeriesMarkers,
  toggleReplaySignalMarkerSelection,
} from './replaySignalRegistry'

describe('retired Custom V2 replay signal dataset registry', () => {
  it('does not load retired V2 signal layers', () => {
    expect(replaySignalDatasetInfos()).toEqual([])
    const markers = toReplaySignalSeriesMarkers('XAUUSD', '5m')
    expect(markers).toHaveLength(0)
    // The signal-layer fallback exposes only causal two-sided geometries when
    // no dedicated range layer is selected; the dedicated layer remains the
    // normal source for the complete lifecycle display.
    expect(toReplaySignalRangeSpecs('XAUUSD', '5m')).toHaveLength(0)
  })

  it('does not resolve markers from retired V2 sources', () => {
    expect(resolveReplaySignalMarker('XAUUSD', '5m', 'replay-signal-xauusd-custom-v2-signals-fec3dee458ec28c7-13')).toBeNull()
    expect(resolveReplaySignalMarker('XAUUSD', '5m', 'replay-signal-xauusd-custom-v2-signals-d66c77cb53f1bd57-1')).toBeNull()
    expect(resolveReplaySignalMarker('XAUUSD', '5m', 'replay-signal-xauusd-custom-v2-signals-988f3958ecbfd485-1')).toBeNull()
    expect(resolveReplaySignalMarker('XAUUSD', '5m', 'replay-signal-xauusd-custom-v2-signals-4e9fb52abb3e8093-1')).toBeNull()
    expect(resolveReplaySignalMarker('XAUUSD', '5m', 'replay-signal-xauusd-custom-v2-signals-21275f41e6bdd382-1')).toBeNull()
    expect(resolveReplaySignalMarker('XAUUSD', '5m', 'replay-signal-xauusd-custom-v2-signals-ac6eac149a2dae84-1')).toBeNull()
    expect(resolveReplaySignalMarker('XAUUSD', '5m', 'replay-signal-xauusd-custom-v2-signals-425f12d21504bf07-1')).toBeNull()
    expect(resolveReplaySignalMarker('XAUUSD', '5m', 'replay-signal-xauusd-custom-v2-signals-65f6a0af2a5385fe-1')).toBeNull()
    expect(resolveReplaySignalMarker('XAUUSD', '5m', 'replay-signal-xauusd-custom-v2-signals-83f384e131c5d821-11')).toBeNull()
    expect(resolveReplaySignalMarker('XAUUSD', '5m', 'replay-signal-xauusd-custom-v2-signals-402ebf4fa9620b9a-1')).toBeNull()
    expect(resolveReplaySignalMarker('XAUUSD', '5m', 'replay-signal-xauusd-custom-v2-signals-8a7cafe3870746b8-999')).toBeNull()
    expect(resolveReplaySignalMarker('XAUUSD', '5m', 'replay-signal-xauusd-custom-v2-signals-8a7cafe3870746b8-1')).toBeNull()
  })

  it('keeps the generic marker toggle ready for future imports', () => {
    expect(toggleReplaySignalMarkerSelection(null, 'future-signal')).toBe('future-signal')
    expect(toggleReplaySignalMarkerSelection('future-signal', 'future-signal')).toBeNull()
  })
})
