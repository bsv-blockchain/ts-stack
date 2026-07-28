import { formatUnknownForLog } from '../formatUnknown'

describe('formatUnknownForLog', () => {
  test('formats primitive values without default object stringification', () => {
    expect(formatUnknownForLog(null)).toBe('')
    expect(formatUnknownForLog(undefined)).toBe('')
    expect(formatUnknownForLog('value')).toBe('value')
    expect(formatUnknownForLog(42)).toBe('42')
    expect(formatUnknownForLog(42n)).toBe('42')
    expect(formatUnknownForLog(true)).toBe('true')
    expect(formatUnknownForLog(false)).toBe('false')
    expect(formatUnknownForLog(Symbol('marker'))).toBe('marker')
    expect(formatUnknownForLog(Symbol())).toBe('')
    expect(formatUnknownForLog(function namedFunction () {})).toBe('[function namedFunction]')
    expect(formatUnknownForLog(() => {})).toBe('[function]')
  })

  test('formats structured diagnostic values safely', () => {
    const date = new Date('2026-07-28T00:00:00.000Z')
    const error = new Error('failure')
    error.stack = undefined
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    expect(formatUnknownForLog(date)).toBe('2026-07-28T00:00:00.000Z')
    expect(formatUnknownForLog(new Date(Number.NaN))).toBe('Invalid Date')
    expect(formatUnknownForLog(error)).toBe('failure')
    expect(formatUnknownForLog({ status: 'failed' })).toBe('{"status":"failed"}')
    expect(formatUnknownForLog({ toJSON: () => undefined })).toBe('[unserializable object]')
    expect(formatUnknownForLog(cyclic)).toBe('[unserializable object]')
  })
})
