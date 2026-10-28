import { brc38JsonDecodedAllocation } from './Brc38JsonAllocation'
import { chargeBrc38ImportDecodedValue } from './Brc38ImportDecodedBudget'

// Authored UNRUN. This estimate is resource DATA, never a JSON/source verdict.
test.each([
  ['scalar', 0],
  ['null', null],
  ['empty object', {}],
  ['single array scalar', [0]],
  ['single array boolean', [true]],
  ['empty array', []],
  ['nested singleton array', [[0]]],
  ['dense array', Array.from({ length: 1000 }, () => 0)],
  ['nested', { a: [1, true, null, { b: 'c' }], d: {} }],
  ['escaped string', { 'a:"[,': '\\"{[,:😀é' }],
  ['long scalar', 'x'.repeat(65536)]
])('%s parse allowance covers the independent decoded model', (_name, value) => {
  const json = JSON.stringify(value),
    maximum = brc38JsonDecodedAllocation(json),
    budget = { maximum, remaining: maximum }
  chargeBrc38ImportDecodedValue(budget, JSON.parse(json))
  expect(budget.remaining).toBeGreaterThanOrEqual(0)
})
test('resource estimation does not claim syntax or semantics', () => {
  expect(brc38JsonDecodedAllocation('{')).toBeGreaterThan(0)
  expect(() => JSON.parse('{')).toThrow()
  expect(brc38JsonDecodedAllocation('"' + 'a'.repeat(65536) + '"')).toBeLessThan(1048576)
})
