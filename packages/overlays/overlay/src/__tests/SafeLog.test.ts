import { serializeErrorForLog, serializeLogValue } from '../SafeLog'

describe('safe log serialization', () => {
  it('escapes characters that can forge log records', () => {
    const serialized = serializeLogValue('first\r\nFORGED\u0085NEL\u2028LINE\u2029PARAGRAPH\u0000')

    expect(serialized).toBe('"first\\r\\nFORGED\\u0085NEL\\u2028LINE\\u2029PARAGRAPH\\u0000"')
    expect(serialized).not.toMatch(/[\r\n\u0085\u2028\u2029]/)
  })

  it('preserves structured data as JSON', () => {
    expect(serializeLogValue({ topic: 'tm_test', count: 2 })).toBe('{"topic":"tm_test","count":2}')
  })

  it.each([
    undefined,
    1n,
    (() => {
      const circular: Record<string, unknown> = {}
      circular.self = circular
      return circular
    })()
  ])('uses a fixed sentinel for an unserializable value', value => {
    expect(serializeLogValue(value)).toBe('"[Unserializable value]"')
  })

  it('serializes Error details without raw line breaks', () => {
    const error = new Error('bad\r\nFORGED')
    const serialized = serializeErrorForLog(error)

    expect(serialized).toContain('"name":"Error"')
    expect(serialized).toContain('bad\\r\\nFORGED')
    expect(serialized).not.toMatch(/[\r\n\u0085\u2028\u2029]/)
  })

  it('serializes non-Error thrown values', () => {
    expect(serializeErrorForLog('bad\nFORGED')).toBe('"bad\\nFORGED"')
  })

  it('uses the fixed sentinel when Error properties cannot be read', () => {
    const error = new Error('hidden')
    Object.defineProperty(error, 'name', {
      get: () => { throw new Error('blocked') }
    })

    expect(serializeErrorForLog(error)).toBe('"[Unserializable value]"')
  })
})
