import { canonicalOriginator, normalizeOriginator } from '../normalizeOriginator'

describe('normalizeOriginator', () => {
  test('strips scheme, port and case down to the lowercase hostname', () => {
    expect(normalizeOriginator('https://Admin.Wallet.Example:8443')).toBe('admin.wallet.example')
    expect(normalizeOriginator('ADMIN.WALLET.EXAMPLE:443')).toBe('admin.wallet.example')
    expect(normalizeOriginator('  admin.wallet.example  ')).toBe('admin.wallet.example')
  })

  test('fails closed on empty, unparsable and non-hostname values', () => {
    expect(normalizeOriginator()).toBe('')
    expect(normalizeOriginator('')).toBe('')
    expect(normalizeOriginator('   ')).toBe('')
    expect(normalizeOriginator('https://%')).toBe('https://%')
    expect(normalizeOriginator('file:///tmp')).toBe('file:///tmp')
    expect(canonicalOriginator()).toBeUndefined()
    expect(canonicalOriginator('')).toBeUndefined()
    expect(canonicalOriginator('   ')).toBeUndefined()
    expect(canonicalOriginator('https://Admin.Wallet.Example:8443')).toBe('admin.wallet.example')
  })

  test('keeps an IPv6 hostname bracketed the same way as the permissions manager', () => {
    // URL.hostname already includes the brackets, and the shared helper wraps any colon.
    expect(normalizeOriginator('https://[::1]')).toBe('[[::1]]')
  })
})
