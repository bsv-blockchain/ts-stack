/** Read one UTF-16 code unit, including either half of a surrogate pair.
 * Packed SQL TEXT and JSON framing use code-unit coordinates, not code points.
 * Keep NaN for a position outside the string.
 */
export function utf16CodeUnitAt(value: string, index: number): number {
  const point = value.codePointAt(index)
  if (point === undefined) return Number.NaN
  return point > 0xffff ? 0xd800 + ((point - 0x10000) >>> 10) : point
}
