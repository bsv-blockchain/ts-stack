import { utf16CodeUnitAt } from '../../utility/utf16CodeUnitAt'
/** UTF-8 length without an encoded array. Lone UTF-16 surrogates count as the
 * replacement scalar, matching TextEncoder and the existing SDK UTF-8 codec.
 * This is scalar DATA accounting, not source/schema/authentication evidence. */
export function brc38Utf8ByteLength(value: string): number {
  if (typeof value !== 'string') throw new TypeError('BRC-38 UTF-8 length requires a string')
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const unit = utf16CodeUnitAt(value, index)
    if (unit < 0x80) bytes++
    else if (unit < 0x800) bytes += 2
    else if (
      unit >= 0xd800 &&
      unit <= 0xdbff &&
      index + 1 < value.length &&
      utf16CodeUnitAt(value, index + 1) >= 0xdc00 &&
      utf16CodeUnitAt(value, index + 1) <= 0xdfff
    ) {
      bytes += 4
      index++
    } else bytes += 3
  }
  return bytes
}
