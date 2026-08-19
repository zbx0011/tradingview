export const CHART_MARKER_HOVER_OPACITY = 0.035

export function dimChartMarkerColor(color: string, opacity = CHART_MARKER_HOVER_OPACITY) {
  const match = /^#([\da-f]{6})$/i.exec(color)
  if (!match) return color
  const value = Number.parseInt(match[1], 16)
  const red = (value >> 16) & 0xff
  const green = (value >> 8) & 0xff
  const blue = value & 0xff
  return `rgba(${red}, ${green}, ${blue}, ${opacity})`
}

export function fadeChartMarkersOnHover<T extends { color: string }>(markers: readonly T[], hoveredMarkerId: string | null): T[] {
  if (hoveredMarkerId === null) return [...markers]
  return markers.map((marker) => ({ ...marker, color: dimChartMarkerColor(marker.color) }))
}
