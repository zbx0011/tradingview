import { describe, expect, it } from 'vitest'
import { chartMarkersForVisibility } from './chartMarkerVisibility'

describe('chart marker visibility toggle', () => {
  it('keeps shape direction markers visible while hiding replay signals', () => {
    const markers = [{ id: 'shape-ai-M14' }, { id: 'replay-signal-1' }]
    expect(chartMarkersForVisibility(markers, true)).toEqual([markers[0]])
    expect(chartMarkersForVisibility(markers, false)).toEqual(markers)
  })
  it('hides every chart marker only when the explicit visibility toggle is active', () => {
    const markers = [
      { id: 'selected', color: '#22ab94' },
      { id: 'nearby', color: '#f7525f' },
    ]

    expect(chartMarkersForVisibility(markers, true)).toEqual([])
    expect(chartMarkersForVisibility(markers, false)).toEqual(markers)
  })
})
