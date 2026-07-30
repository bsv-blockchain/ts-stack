import { formatTraceparent, parseTraceparent } from '../traceContext'

describe('wallet-toolbox trace-context compatibility', () => {
  const traceId = '1'.repeat(32)
  const spanId = '2'.repeat(16)

  it('round-trips a valid W3C version-00 header', () => {
    const header = formatTraceparent({ traceId, spanId, traceFlags: 1 })
    expect(header).toBe(`00-${traceId}-${spanId}-01`)
    expect(parseTraceparent(header)).toEqual({ traceId, spanId, traceFlags: 1 })
  })

  it.each([
    undefined,
    42,
    '',
    'x'.repeat(129),
    `01-${traceId}-${spanId}-01`,
    `00-${'0'.repeat(32)}-${spanId}-01`,
    `00-${traceId}-${'0'.repeat(16)}-01`
  ])('ignores malformed traceparent value %p', value => {
    expect(parseTraceparent(value)).toBeUndefined()
  })

  it('refuses invalid IDs and clamps trace flags', () => {
    expect(formatTraceparent({ traceId: 'invalid', spanId })).toBeUndefined()
    expect(formatTraceparent({ traceId, spanId: 'invalid' })).toBeUndefined()
    expect(formatTraceparent({ traceId, spanId, traceFlags: 999 })?.endsWith('-ff')).toBe(true)
  })
})
