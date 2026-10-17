/** Conservative owned decoded-JSON allowance before JSON.parse. Counting is
 * allocation DATA only: this pass neither validates JSON syntax nor remembers
 * a source/semantic verdict. Actual JSON parsing and source checks remain
 * mandatory. Delimiters inside escaped strings do not count as containers.
 * String/code-unit costs plus structural slots cover the portable decoded
 * budget's per-value, property, array and key costs without treating every
 * character of a long scalar as a separate object. */
export function brc38JsonDecodedAllocation(json: string): number {
  if (typeof json !== 'string') throw new TypeError('BRC-38 JSON allocation requires a string')
  let bytes = 256 + 8 * json.length,
    quoted = false,
    escaped = false
  for (let index = 0; index < json.length; index++) {
    const unit = json.charCodeAt(index)
    if (quoted) {
      if (escaped) escaped = false
      else if (unit === 92) escaped = true
      else if (unit === 34) quoted = false
    } else if (unit === 34) quoted = true
    else if (unit === 91) bytes += 640
    else if (unit === 123 || unit === 58 || unit === 44) bytes += 512
  }
  if (!Number.isSafeInteger(bytes)) throw new RangeError('BRC-38 JSON allocation exceeds safe accounting')
  return bytes
}
