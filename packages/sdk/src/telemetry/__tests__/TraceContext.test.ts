import { formatTraceparent, parseTraceparent } from '../TraceContext'

describe('W3C trace context', () => {
  const traceId = '11111111111111111111111111111111'
  const spanId = '2222222222222222'

  it('round-trips a valid version-00 traceparent', () => {
    const value = formatTraceparent({ traceId, spanId, traceFlags: 1 })
    expect(value).toBe(`00-${traceId}-${spanId}-01`)
    expect(parseTraceparent(value)).toEqual({ traceId, spanId, traceFlags: 1 })
  })

  it.each([
    undefined,
    '',
    `01-${traceId}-${spanId}-01`,
    `00-${'0'.repeat(32)}-${spanId}-01`,
    `00-${traceId}-${'0'.repeat(16)}-01`,
    `00-${traceId}-short-01`,
    `00-${traceId}-${spanId}-0100`,
    'x'.repeat(129)
  ])('rejects malformed or unsupported input %#', value => {
    expect(parseTraceparent(value)).toBeUndefined()
  })

  it('does not format invalid identifiers', () => {
    expect(formatTraceparent({ traceId: 'invalid', spanId })).toBeUndefined()
    expect(formatTraceparent({ traceId, spanId: 'invalid' })).toBeUndefined()
  })
})
