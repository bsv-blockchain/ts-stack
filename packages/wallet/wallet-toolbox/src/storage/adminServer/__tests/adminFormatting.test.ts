import { alignLeft, alignRight, asNumber, toAdminStatsLog } from '../adminServer'

describe('storage admin diagnostic formatting', () => {
  test('normalizes numeric and structured values without default object coercion', () => {
    expect(asNumber('42', 7)).toBe(42)
    expect(asNumber({ value: 42 }, 7)).toBe(7)
    expect(alignLeft({ status: 'ok' }, 8)).toBe('{"statu…')
    expect(alignRight({ status: 'ok' }, 8)).toBe('…":"ok"}')
  })

  test('renders structured request metadata in the statistics header', () => {
    const log = toAdminStatsLog({
      when: new Date('2026-07-28T00:00:00.000Z'),
      requestedBy: { service: 'monitor' },
      usersDay: 1,
      usersWeek: 2,
      usersMonth: 3,
      usersTotal: 4
    })

    expect(log).toContain('2026-07-28T00:00:00.000Z')
    expect(log).toContain('{"service":"monitor"}')
    expect(log).toContain('users')
  })
})
