/**
 * Order two strings by UTF-16 code unit, the order `Array.prototype.sort` uses without a
 * comparator: -1 when `left` comes first, 1 when `right` does, 0 when they are equal.
 * Locale-independent, so both peers of a connection sort the same way.
 */
export function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
