import { utf16CodeUnitAt } from './utf16CodeUnitAt'

test('preserves every single UTF-16 unit, including lone surrogates', () => {
  for (let unit = 0; unit <= 0xffff; unit++) {
    expect(utf16CodeUnitAt(String.fromCodePoint(unit), 0)).toBe(unit)
  }
})

test('keeps paired surrogates and code-unit offsets distinct', () => {
  const value = 'A\ud83d\ude00\ud800Z\udc00'
  expect(Array.from({ length: value.length }, (_, index) => utf16CodeUnitAt(value, index))).toEqual([
    65, 0xd83d, 0xde00, 0xd800, 90, 0xdc00
  ])
  expect(utf16CodeUnitAt('A', 0.9)).toBe(65)
  expect(utf16CodeUnitAt('A', Number.NaN)).toBe(65)
  for (const index of [-1, 1, Infinity, -Infinity]) expect(utf16CodeUnitAt('A', index)).toBeNaN()
  expect(utf16CodeUnitAt('', 0)).toBeNaN()
})

test('native schema entries retain their checked observer names during import', async () => {
  await expect(import('../storage/portable/Brc38NativePackedTextSchemaNode')).resolves.toEqual(
    expect.objectContaining({ hasBrc38NativePackedTextSchema: expect.any(Function) })
  )
  await expect(import('../storage/portable/Brc38NativePreparedFieldSchemaNode')).resolves.toEqual(
    expect.objectContaining({ hasBrc38NativePreparedFieldsSchema: expect.any(Function) })
  )
})
