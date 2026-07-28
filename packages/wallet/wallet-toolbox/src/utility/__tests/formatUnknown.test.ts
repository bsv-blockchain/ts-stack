import { formatUnknownForLog } from '../formatUnknown'

describe('formatUnknownForLog', () => {
  test('formats primitive values without default object stringification', () => {
    expect(formatUnknownForLog(null)).toBe('')
    expect(formatUnknownForLog('value')).toBe('value')
    expect(formatUnknownForLog(42)).toBe('42')
    expect(formatUnknownForLog(42n)).toBe('42')
    expect(formatUnknownForLog(true)).toBe('true')
    expect(formatUnknownForLog(Symbol('marker'))).toBe('marker')
  })

  test('formats structured diagnostic values safely', () => {
    const date = new Date('2026-07-28T00:00:00.000Z')
    const error = new Error('failure')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    expect(formatUnknownForLog(date)).toBe('2026-07-28T00:00:00.000Z')
    expect(formatUnknownForLog(error)).toContain('failure')
    expect(formatUnknownForLog({ status: 'failed' })).toBe('{"status":"failed"}')
    expect(formatUnknownForLog(cyclic)).toBe('[unserializable object]')
  })
})
