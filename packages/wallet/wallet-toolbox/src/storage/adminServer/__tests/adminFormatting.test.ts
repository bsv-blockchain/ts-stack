import { alignLeft, alignRight, asNumber, toAdminStatsLog } from '../adminServer'
import { renderAdminPage } from '../adminUi'

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

  test('renders UTXO review as scan-only by default with explicit release confirmation', () => {
    const page = renderAdminPage()

    expect(page).toContain('<option value="scan">scan only</option>')
    expect(page).toContain('<option value="release">release confirmed-spent outputs</option>')
    expect(page).toContain("const release = byId('utxoAction').value === 'release'")
    expect(page).toContain('Release only outputs conclusively confirmed spent?')
    expect(page).toContain('JSON.stringify({ identityKey, mode, release, pageLimit: 20, offset })')
    expect(page).toContain('if (result.complete || result.nextOffset == null) break')
  })
})
