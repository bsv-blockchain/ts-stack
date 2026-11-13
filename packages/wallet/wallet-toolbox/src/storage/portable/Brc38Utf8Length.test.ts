import { brc38Utf8ByteLength } from './Brc38Utf8Length'
import { toArray } from '@bsv/sdk/primitives/utils'

// Authored UNRUN. Independent codec comparisons, not browser qualification.
test.each([
  ['empty', ''],
  ['ascii', 'ascii'],
  ['NUL', '\0'],
  ['two bytes', 'é'],
  ['three bytes', '€'],
  ['four bytes', '😀'],
  ['lone high', '\ud800'],
  ['lone low', '\udc00'],
  ['two high', '\ud800\ud800'],
  ['reversed pair', '\udc00\ud800'],
  ['mixed', 'é😀\ud800z'],
  ['64KiB ASCII', 'a'.repeat(65536)],
  ['64KiB UTF-8', 'é'.repeat(32768)]
])('%s scalar UTF-8 length agrees with existing codecs', (_name, value) => {
  expect(brc38Utf8ByteLength(value)).toBe(new TextEncoder().encode(value).byteLength)
  expect(brc38Utf8ByteLength(value)).toBe(Buffer.byteLength(value, 'utf8'))
  expect(brc38Utf8ByteLength(value)).toBe(toArray(value, 'utf8').length)
})
