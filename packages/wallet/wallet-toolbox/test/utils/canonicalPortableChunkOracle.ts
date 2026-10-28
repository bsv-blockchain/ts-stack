export type CanonicalTestValue =
  string | number | boolean | CanonicalTestValue[] | { [key: string]: CanonicalTestValue }

/** Independent whole-value oracle for positive JSON fixtures only. */
export function canonicalTestReference(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new TypeError('The canonical reference requires a JSON fixture')
    return encoded
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalTestReference).join(',') + ']'
  return (
    '{' +
    Object.entries(value)
      .sort(([first], [second]) => Number(first > second) - Number(first < second))
      .map(([key, child]) => JSON.stringify(key) + ':' + canonicalTestReference(child))
      .join(',') +
    '}'
  )
}

/** Check the complete independent byte oracle while consuming. A broken
 * serializer must fail before its divergent output can grow without bound.
 * Keep the original chunks so buffer identity and final byte checks still run.
 */
export function collectExpectedCanonicalChunks(
  source: Iterable<Uint8Array>,
  expectedBytes: string | Uint8Array
): Uint8Array[] {
  const expected = typeof expectedBytes === 'string' ? Buffer.from(expectedBytes, 'utf8') : expectedBytes,
    chunks: Uint8Array[] = []
  let offset = 0
  for (const chunk of source) {
    const next = offset + chunk.byteLength
    expect(chunk.byteLength).toBeGreaterThan(0)
    expect(next).toBeLessThanOrEqual(expected.byteLength)
    expect(Buffer.compare(chunk, expected.subarray(offset, next))).toBe(0)
    chunks.push(chunk)
    offset = next
  }
  expect(offset).toBe(expected.byteLength)
  return chunks
}
