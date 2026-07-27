import { WalletLogger } from '../WalletLogger'

describe('WalletLogger.toLogString', () => {
  test('preserves elapsed times, indentation, markers, and inherited group labels', () => {
    const logger = new WalletLogger()
    logger.logs = [
      { when: 1000, indent: 0, isBegin: true, isEnd: false, isError: false, log: 'outer' },
      { when: 1010, indent: 1, isBegin: false, isEnd: false, isError: false, log: 'message' },
      { when: 1025, indent: 1, isBegin: false, isEnd: true, isError: false, log: '' },
      { when: 1040, indent: 0, isBegin: false, isEnd: false, isError: true, log: 'failure' }
    ]

    expect(logger.toLogString()).toBe(
      '   msecs WalletLogger 1970-01-01T00:00:01.000Z logged 0.04 seconds\n' +
      '       0 begin outer\n' +
      '      10   message\n' +
      '      15   end outer\n' +
      '      15 ERROR failure\n'
    )
  })

  test('preserves the empty log representation', () => {
    expect(new WalletLogger().toLogString()).toBe('')
  })
})
