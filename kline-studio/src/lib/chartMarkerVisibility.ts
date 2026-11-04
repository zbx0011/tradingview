export function chartMarkersForVisibility<T extends { id?: string }>(markers: readonly T[], hidden: boolean): T[] {
  return hidden ? markers.filter(marker => marker.id?.startsWith('shape-ai-')) : [...markers]
}
