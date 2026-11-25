/** Assign stable render keys while preserving duplicate values and their order. */
export function keyedValues(values: readonly string[]) {
  const occurrences = new Map<string, number>()
  return values.map(value => {
    const occurrence = (occurrences.get(value) ?? 0) + 1
    occurrences.set(value, occurrence)
    return { key: JSON.stringify([value, occurrence]), value }
  })
}
