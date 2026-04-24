import { stampLog, stampLogFormat } from '../../../../../src/utility/stampLog'
import { TestUtilsWalletStorage as _tu, TestWalletNoSetup } from '../../../../../test/utils/TestUtilsWalletStorage'

describe('stampLog and stampLogFormat Tests', () => {
  jest.setTimeout(99999999)

  const ctxs: TestWalletNoSetup[] = []

  beforeAll(async () => {
    // Set up test contexts for MySQL and SQLite
    ctxs.push(await _tu.createLegacyWalletSQLiteCopy('stampLogTests'))
  })

  afterAll(async () => {
    for (const ctx of ctxs) {
      await ctx.storage.destroy()
    }
  })

  // Test: Appending to string logs
  test('0_appends_to_string_log', async () => {
    for (const { wallet } of ctxs) {
      const initialLog = '2025-01-10T10:00:00.000Z Event 1\n'
      const lineToAdd = 'Event 2'
      const updatedLog = stampLog(initialLog, lineToAdd)
      expect(updatedLog).toContain('Event 2')
      expect(updatedLog).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z Event 2\n$/)
    }
  })

  // Test: Appending to object logs
  test('1_appends_to_object_log', async () => {
    for (const { wallet } of ctxs) {
      const initialLog = { log: '2025-01-10T10:00:00.000Z Event 1\n' }
      const lineToAdd = 'Event 2'
      const updatedLog = stampLog(initialLog, lineToAdd)
      expect(updatedLog).toContain('Event 2')
      expect(updatedLog).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z Event 2\n$/)
    }
  })

  // Test: Returns undefined for invalid input
  test('2_returns_undefined_for_invalid_input', async () => {
    for (const { wallet } of ctxs) {
      const updatedLog = stampLog(undefined, 'Event 1')
      expect(updatedLog).toBeUndefined()
    }
  })

  // Test: Formatting valid log without **NETWORK**
  test('3_formats_valid_log_without_network', async () => {
    for (const { wallet } of ctxs) {
      const log = `2025-01-10T10:00:00.000Z Event 1\n2025-01-10T10:00:01.000Z Event 2\n2025-01-10T10:00:03.000Z Event 3`
      const output = stampLogFormat(log)
      expect(output).toContain('Total = 3000 msecs')
      expect(output).toContain(' 1000 Event 2')
      expect(output).toContain(' 2000 Event 3')
    }
  })

  // Test: Formatting valid log with **NETWORK** entries
  test('4_formats_log_with_network_entries', async () => {
    for (const { wallet } of ctxs) {
      const log = `2025-01-10T10:00:00.000Z Event 1\n2025-01-10T10:00:01.000Z **NETWORK**\n2025-01-10T10:00:02.000Z Event 2\n2025-01-10T10:00:03.000Z **NETWORK**\n2025-01-10T10:00:05.000Z Event 3`
      const output = stampLogFormat(log)
      expect(output).toContain('Total = 5000 msecs')
      expect(output).toContain(' 1000 **NETWORK**')
      expect(output).toContain(' 2000 Event 3')
    }
  })

  // Test: Handles improperly formatted log entries
  test('5_handles_invalid_log_entries_gracefully', async () => {
    for (const { wallet } of ctxs) {
      const log = `Invalid Timestamp Event 1\n2025-01-10T10:00:01.000Z Event 2`

      // Expect the function to throw a RangeError due to invalid timestamp
      expect(() => stampLogFormat(log)).toThrow(RangeError)
    }
  })

  // Test: Handles non-string input
  test('6_handles_non-string_log_gracefully', () => {
    const nonStringInputs = [undefined, null, 123, {}, [], true] // Different non-string values
    for (const input of nonStringInputs) {
      const result = stampLogFormat(input as unknown as string)
      expect(result).toBe('') // Should return an empty string for non-string inputs
    }
  })
})
