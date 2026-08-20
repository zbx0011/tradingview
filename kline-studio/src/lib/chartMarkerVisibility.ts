export function chartMarkersForVisibility<T>(markers: readonly T[], hidden: boolean): T[] {
  return hidden ? [] : [...markers]
}
