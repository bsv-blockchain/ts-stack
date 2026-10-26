/**
 * Order canonical field names by UTF-16 code units, matching the historical
 * default Array.sort order. Locale collation would change signed field order.
 * Kept internal to Simple's certificate and persistence implementations.
 */
export function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
