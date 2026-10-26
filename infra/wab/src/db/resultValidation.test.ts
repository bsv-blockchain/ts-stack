import { insertedIdFromResult } from './resultValidation'

describe('insertedIdFromResult', () => {
  it.each([
    [7, 7],
    [[8], 8],
    [{ id: 9 }, 9],
    [[{ id: 10 }], 10]
  ])('accepts supported positive safe insert identifiers', (result, expected) => {
    expect(insertedIdFromResult(result)).toBe(expected)
  })

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects the invalid numeric identifier %s',
    id => {
      expect(insertedIdFromResult(id)).toBeUndefined()
      expect(insertedIdFromResult({ id })).toBeUndefined()
    }
  )

  it('rejects inherited and sparse array entries', () => {
    const inherited: unknown[] = []
    inherited.length = 1
    Object.setPrototypeOf(inherited, { 0: 11 })
    const sparse: unknown[] = []
    sparse.length = 1

    expect(insertedIdFromResult(inherited)).toBeUndefined()
    expect(insertedIdFromResult(sparse)).toBeUndefined()
  })

  it('rejects array and object accessors without invoking them', () => {
    let getterCalls = 0
    const arrayResult: unknown[] = []
    Object.defineProperty(arrayResult, '0', {
      configurable: true,
      get: () => {
        getterCalls += 1
        return 12
      }
    })
    const objectResult = Object.create({ id: 13 }) as Record<string, unknown>
    Object.defineProperty(objectResult, 'id', {
      configurable: true,
      get: () => {
        getterCalls += 1
        return 14
      }
    })

    expect(insertedIdFromResult(arrayResult)).toBeUndefined()
    expect(insertedIdFromResult(objectResult)).toBeUndefined()
    expect(getterCalls).toBe(0)
  })

  it('ignores an inherited descriptor value property', () => {
    const accessorResult: unknown[] = []
    Object.defineProperty(accessorResult, '0', {
      configurable: true,
      get: () => 16
    })
    Object.defineProperty(Object.prototype, 'value', {
      configurable: true,
      value: 15
    })
    try {
      expect(insertedIdFromResult(accessorResult)).toBeUndefined()
    } finally {
      delete (Object.prototype as { value?: unknown }).value
    }
  })
})
