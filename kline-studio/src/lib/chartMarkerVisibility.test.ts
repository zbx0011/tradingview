import { describe, expect, it } from 'vitest'
import { CHART_MARKER_HOVER_OPACITY, dimChartMarkerColor, fadeChartMarkersOnHover } from './chartMarkerVisibility'

describe('chart marker hover visibility', () => {
  it('makes every chart marker nearly transparent while any marker is hovered', () => {
    const markers = [
      { id: 'selected', color: '#22ab94' },
      { id: 'nearby', color: '#f7525f' },
    ]

    expect(fadeChartMarkersOnHover(markers, 'selected')).toEqual([
      { id: 'selected', color: `rgba(34, 171, 148, ${CHART_MARKER_HOVER_OPACITY})` },
      { id: 'nearby', color: `rgba(247, 82, 95, ${CHART_MARKER_HOVER_OPACITY})` },
    ])
  })

  it('keeps marker colors unchanged away from markers', () => {
    expect(fadeChartMarkersOnHover([{ color: '#38bdf8' }], null)).toEqual([{ color: '#38bdf8' }])
    expect(dimChartMarkerColor('currentColor')).toBe('currentColor')
  })
})
