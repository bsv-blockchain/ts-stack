import { FixedWindowBulkFileDownloadBudget } from '../FixedWindowBulkFileDownloadBudget'

describe('FixedWindowBulkFileDownloadBudget', () => {
  test('tracks reservations and rejects a request beyond the remaining budget', () => {
    let now = 1_000
    const budget = new FixedWindowBulkFileDownloadBudget({
      maxBytes: 10,
      windowMsecs: 100,
      now: () => now
    })

    budget.consume(4)
    expect(budget.snapshot()).toEqual({
      maxBytes: 10,
      consumedBytes: 4,
      windowStartedAt: 1_000,
      windowMsecs: 100
    })
    expect(() => budget.consume(7)).toThrow(
      'Bulk-header download budget exceeded: requested 7 bytes with 6 bytes remaining in the current window.'
    )
    expect(budget.snapshot().consumedBytes).toBe(4)

    now = 1_100
    budget.consume(7)
    expect(budget.snapshot()).toEqual({
      maxBytes: 10,
      consumedBytes: 7,
      windowStartedAt: 1_100,
      windowMsecs: 100
    })
  })

  test('uses the one-hour clock defaults', () => {
    const budget = new FixedWindowBulkFileDownloadBudget({ maxBytes: 1 })
    expect(budget.snapshot()).toMatchObject({
      maxBytes: 1,
      consumedBytes: 0,
      windowMsecs: 60 * 60 * 1000
    })
    expect(Number.isFinite(budget.snapshot().windowStartedAt)).toBe(true)
  })

  test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid maximum byte budget %p', maxBytes => {
    expect(() => new FixedWindowBulkFileDownloadBudget({ maxBytes })).toThrow(
      'The maxBytes parameter must be a positive safe integer'
    )
  })

  test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid window %p', windowMsecs => {
    expect(() => new FixedWindowBulkFileDownloadBudget({ maxBytes: 1, windowMsecs })).toThrow(
      'The windowMsecs parameter must be a positive safe integer'
    )
  })

  test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid reservation %p', byteCount => {
    const budget = new FixedWindowBulkFileDownloadBudget({ maxBytes: 10 })
    expect(() => budget.consume(byteCount)).toThrow('The byteCount parameter must be a positive safe integer')
  })
})
