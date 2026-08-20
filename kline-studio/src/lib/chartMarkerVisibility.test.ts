import { describe, expect, it } from 'vitest'
import { chartMarkersForVisibility } from './chartMarkerVisibility'

describe('chart marker visibility toggle', () => {
  it('hides every chart marker only when the explicit visibility toggle is active', () => {
    const markers = [
      { id: 'selected', color: '#22ab94' },
      { id: 'nearby', color: '#f7525f' },
    ]

    expect(chartMarkersForVisibility(markers, true)).toEqual([])
    expect(chartMarkersForVisibility(markers, false)).toEqual(markers)
  })
})
