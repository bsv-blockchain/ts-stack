import { WalletError } from '../WalletError'
import { WalletErrorFromJson } from '../WalletErrorFromJson'
import {
  WERR_NOT_IMPLEMENTED,
  WERR_INTERNAL,
  WERR_INVALID_PARAMETER,
  WERR_REVIEW_ACTIONS,
  WERR_INSUFFICIENT_FUNDS,
  WERR_BROADCAST_UNAVAILABLE,
  WERR_NETWORK_CHAIN,
  WERR_INVALID_OPERATION,
  WERR_MISSING_PARAMETER,
  WERR_BAD_REQUEST,
  WERR_UNAUTHORIZED,
  WERR_NOT_ACTIVE,
  WERR_INVALID_PUBLIC_KEY
} from '../WERR_errors'

// Mock WalletStorage interface
const mockWalletStorage = {
  createAction: jest.fn().mockImplementation((args: any) => {
    throw new WERR_REVIEW_ACTIONS(
      [{ txid: 'txid123', status: 'doubleSpend', competingTxs: ['txid456'], competingBeef: [0, 1, 2, 3] }],
      [{ txid: 'txid123', status: 'failed' }],
      'txid123',
      [5, 6, 7, 8],
      ['00'.repeat(32) + '.0']
    )
  })
}

describe('WalletError tests', () => {
  jest.setTimeout(99999999)

  test('0 - WERR_REVIEW_ACTIONS from createAction failure', async () => {
    try {
      await mockWalletStorage.createAction({ someArgs: 'test' })
    } catch (err) {
      const werr = WalletError.fromUnknown(err)
      expect(werr.name).toBe('WERR_REVIEW_ACTIONS')
      expect(werr.message).toBe('Undelayed createAction or signAction results require review.')

      const json = WalletError.unknownToJson(werr)
      const werr2 = WalletErrorFromJson(JSON.parse(json))
      expect(werr2 instanceof WERR_REVIEW_ACTIONS).toBe(true)
      const werr3 = werr2 as WERR_REVIEW_ACTIONS
      expect(werr3.txid).toBe('txid123')
      expect(werr3.reviewActionResults).toEqual([
        { txid: 'txid123', status: 'doubleSpend', competingTxs: ['txid456'], competingBeef: [0, 1, 2, 3] }
      ])
      expect(werr3.sendWithResults).toEqual([{ txid: 'txid123', status: 'failed' }])
      expect(werr3.noSendChange).toEqual(['00'.repeat(32) + '.0'])
    }
  })

  test('1 - WERR_NOT_IMPLEMENTED basic test', async () => {
    const werr = new WERR_NOT_IMPLEMENTED('Custom not implemented message')
    expect(werr.name).toBe('WERR_NOT_IMPLEMENTED')
    expect(werr.message).toBe('Custom not implemented message')

    const json = WalletError.unknownToJson(werr)
    const werr2 = WalletErrorFromJson(JSON.parse(json))
    expect(werr2.name).toBe('WERR_NOT_IMPLEMENTED')
    expect(werr2.message).toBe('Custom not implemented message')
  })

  test('2 - WERR_INTERNAL with default message', async () => {
    const werr = new WERR_INTERNAL()
    expect(werr.name).toBe('WERR_INTERNAL')
    expect(werr.message).toBe('An internal error has occurred.')

    const json = WalletError.unknownToJson(werr)
    const werr2 = WalletErrorFromJson(JSON.parse(json))
    expect(werr2.name).toBe('WERR_INTERNAL')
    expect(werr2.message).toBe('An internal error has occurred.')
  })

  test('3 - WERR_INVALID_PARAMETER with custom parameter', async () => {
    const werr = new WERR_INVALID_PARAMETER('amount', 'positive')
    expect(werr.name).toBe('WERR_INVALID_PARAMETER')
    expect(werr.message).toBe('The amount parameter must be positive')
    expect(werr.parameter).toBe('amount')

    const json = werr.toJson()
    const werr2 = WalletErrorFromJson(JSON.parse(json))
    expect(werr2.name).toBe('WERR_INVALID_PARAMETER')
    expect(werr2.message).toBe('The amount parameter must be positive')
    expect((werr2 as WERR_INVALID_PARAMETER).parameter).toBe('amount')
  })

  test('4 - WERR_INSUFFICIENT_FUNDS with numeric values', async () => {
    const werr = new WERR_INSUFFICIENT_FUNDS(1000, 500)
    expect(werr.name).toBe('WERR_INSUFFICIENT_FUNDS')
    expect(werr.message).toContain('500 more satoshis are needed')
    expect(werr.message).toContain('for a total of 1000')
    expect(werr.totalSatoshisNeeded).toBe(1000)
    expect(werr.moreSatoshisNeeded).toBe(500)

    const json = werr.toJson()
    const werr2 = WalletErrorFromJson(JSON.parse(json))
    expect(werr2.name).toBe('WERR_INSUFFICIENT_FUNDS')
    expect((werr2 as WERR_INSUFFICIENT_FUNDS).totalSatoshisNeeded).toBe(1000)
    expect((werr2 as WERR_INSUFFICIENT_FUNDS).moreSatoshisNeeded).toBe(500)
  })

  test('5 - WERR_BROADCAST_UNAVAILABLE test', async () => {
    const werr = new WERR_BROADCAST_UNAVAILABLE('Network issue')
    expect(werr.name).toBe('WERR_BROADCAST_UNAVAILABLE')
    expect(werr.message).toBe('Unable to broadcast transaction at this time.')

    const json = WalletError.unknownToJson(werr)
    const werr2 = WalletErrorFromJson(JSON.parse(json))
    expect(werr2.name).toBe('WERR_BROADCAST_UNAVAILABLE')
    expect(werr2.message).toBe('Unable to broadcast transaction at this time.')
  })

  test('6 - WERR_NETWORK_CHAIN test', async () => {
    const werr = new WERR_NETWORK_CHAIN('Chain mismatch')
    expect(werr.name).toBe('WERR_NETWORK_CHAIN')
    expect(werr.message).toBe('Chain mismatch')

    const json = WalletError.unknownToJson(werr)
    const werr2 = WalletErrorFromJson(JSON.parse(json))
    expect(werr2.name).toBe('WERR_NETWORK_CHAIN')
    expect(werr2.message).toBe('Chain mismatch')
  })

  test('7 - WalletError.fromUnknown with plain Error', async () => {
    const err = new Error('Test error')
    const werr = WalletError.fromUnknown(err)
    expect(werr.name).toBe('WERR_UNKNOWN')
    expect(werr.message).toBe('Test error')
  })

  test('8 - WalletError.unknownToJson with unknown object', async () => {
    const obj = { custom: 'data', code: 404 }
    const json = WalletError.unknownToJson(obj)
    const werr = WalletErrorFromJson(JSON.parse(json))
    expect(werr.name).toBe('WERR_UNKNOWN')
    expect(werr.message).toBe('[object Object]')
  })

  test('9 - WERR_INVALID_OPERATION basic test', async () => {
    const werr = new WERR_INVALID_OPERATION('Custom invalid operation message')
    expect(werr.name).toBe('WERR_INVALID_OPERATION')
    expect(werr.message).toBe('Custom invalid operation message')

    const json = WalletError.unknownToJson(werr)
    const werr2 = WalletErrorFromJson(JSON.parse(json))
    expect(werr2.name).toBe('WERR_INVALID_OPERATION')
    expect(werr2.message).toBe('Custom invalid operation message')
  })

  test('10 - WERR_MISSING_PARAMETER with parameter', async () => {
    const werr = new WERR_MISSING_PARAMETER('requiredField')
    expect(werr.name).toBe('WERR_MISSING_PARAMETER')
    expect(werr.message).toBe('The required requiredField parameter is missing.')
    expect(werr.parameter).toBe('requiredField')

    const json = werr.toJson()
    const werr2 = WalletErrorFromJson(JSON.parse(json))
    expect(werr2.name).toBe('WERR_MISSING_PARAMETER')
    expect(werr2.message).toBe('The required requiredField parameter is missing.')
    expect((werr2 as WERR_MISSING_PARAMETER).parameter).toBe('requiredField')
  })

  test('11 - WERR_BAD_REQUEST with custom message', async () => {
    const werr = new WERR_BAD_REQUEST('Invalid request data')
    expect(werr.name).toBe('WERR_BAD_REQUEST')
    expect(werr.message).toBe('Invalid request data')

    const json = WalletError.unknownToJson(werr)
    const werr2 = WalletErrorFromJson(JSON.parse(json))
    expect(werr2.name).toBe('WERR_BAD_REQUEST')
    expect(werr2.message).toBe('Invalid request data')
  })

  test('12 - WERR_UNAUTHORIZED with default message', async () => {
    const werr = new WERR_UNAUTHORIZED()
    expect(werr.name).toBe('WERR_UNAUTHORIZED')
    expect(werr.message).toBe('Access is denied due to an authorization error.')

    const json = WalletError.unknownToJson(werr)
    const werr2 = WalletErrorFromJson(JSON.parse(json))
    expect(werr2.name).toBe('WERR_UNAUTHORIZED')
    expect(werr2.message).toBe('Access is denied due to an authorization error.')
  })

  test('13 - WERR_NOT_ACTIVE with default message', async () => {
    const werr = new WERR_NOT_ACTIVE()
    expect(werr.name).toBe('WERR_NOT_ACTIVE')
    expect(werr.message).toBe(
      `WalletStorageManager is not accessing user's active storage or there are conflicting active stores configured.`
    )

    const json = WalletError.unknownToJson(werr)
    const werr2 = WalletErrorFromJson(JSON.parse(json))
    expect(werr2.name).toBe('WERR_NOT_ACTIVE')
    expect(werr2.message).toBe(
      `WalletStorageManager is not accessing user's active storage or there are conflicting active stores configured.`
    )
  })

  test('14 - WERR_INVALID_PUBLIC_KEY with key and mainnet network', async () => {
    const werr = new WERR_INVALID_PUBLIC_KEY('invalidkey123', 'mainnet')
    expect(werr.name).toBe('WERR_INVALID_PUBLIC_KEY')
    expect(werr.message).toBe('The provided public key "invalidkey123" is invalid or malformed.')
    expect((werr as WERR_INVALID_PUBLIC_KEY).key).toBe('invalidkey123')

    const json = WalletError.unknownToJson(werr)
    const parsedJson = JSON.parse(json)
    const werr2 = WalletErrorFromJson(parsedJson)
    expect(werr2.name).toBe('WERR_INVALID_PUBLIC_KEY')
    expect(werr2.message).toBe('The provided public key "invalidkey123" is invalid or malformed.')
    expect((werr2 as WERR_INVALID_PUBLIC_KEY).key).toBe('invalidkey123')
  })

  test('15 - WERR_INVALID_PUBLIC_KEY with key and testnet network', async () => {
    const werr = new WERR_INVALID_PUBLIC_KEY('invalidkey123', 'testnet')
    expect(werr.name).toBe('WERR_INVALID_PUBLIC_KEY')
    expect(werr.message).toBe('The provided public key is invalid or malformed.')
    expect((werr as WERR_INVALID_PUBLIC_KEY).key).toBe('invalidkey123')

    const json = WalletError.unknownToJson(werr)
    const parsedJson = JSON.parse(json)
    const werr2 = WalletErrorFromJson(parsedJson)
    expect(werr2.name).toBe('WERR_INVALID_PUBLIC_KEY')
    expect(werr2.message).toBe('The provided public key is invalid or malformed.')
    expect((werr2 as WERR_INVALID_PUBLIC_KEY).key).toBe('invalidkey123')
  })

  test('16 - WalletError basic constructor with details and stack', async () => {
    const customStack = 'custom stack trace'
    const werr = new WalletError('WERR_TEST', 'Test message', customStack, { detail1: 'value1', detail2: 'value2' })
    expect(werr.isError).toBe(true)
    expect(werr.name).toBe('WERR_TEST')
    expect(werr.message).toBe('Test message')
    expect(werr.stack).toBe(customStack)
    expect(werr.details).toEqual({ detail1: 'value1', detail2: 'value2' })
    expect(werr.code).toBe('WERR_TEST')
    expect(werr.description).toBe('Test message')

    werr.code = 'WERR_NEW_CODE'
    werr.description = 'New description'
    expect(werr.name).toBe('WERR_NEW_CODE')
    expect(werr.message).toBe('New description')
  })

  test('17 - WalletError.fromUnknown with string', async () => {
    const werr = WalletError.fromUnknown('String error message')
    expect(werr.name).toBe('WERR_UNKNOWN')
    expect(werr.message).toBe('String error message')
  })

  test('18 - WalletError.fromUnknown with number', async () => {
    const werr = WalletError.fromUnknown(404)
    expect(werr.name).toBe('WERR_UNKNOWN')
    expect(werr.message).toBe('404')
  })

  test('19 - WalletError.fromUnknown with custom object', async () => {
    const obj = { code: 'ERR_404', message: 'Not found', status: 404 }
    const werr = WalletError.fromUnknown(obj)
    expect(werr.name).toBe('ERR_404')
    expect(werr.message).toBe('Not found')
  })

  test('20 - WalletError.fromUnknown with nested walletError', async () => {
    const innerErr = new WERR_INTERNAL('Inner error')
    const outerObj = { message: 'Outer error', walletError: innerErr }
    const werr = WalletError.fromUnknown(outerObj)
    expect(werr.name).toBe('WERR_UNKNOWN')
    expect(werr.message).toBe('Outer error')
    expect((werr as any).walletError).toBeInstanceOf(WERR_INTERNAL)
    expect((werr as any).walletError.message).toBe('Inner error')
  })

  test('21 - WalletError.fromUnknown with SQL details', async () => {
    const err = { name: 'DBError', message: 'Query failed', sql: 'SELECT * FROM table', sqlMessage: 'Syntax error' }
    const werr = WalletError.fromUnknown(err)
    expect(werr.name).toBe('DBError')
    expect(werr.message).toBe('Query failed')
    expect(werr.details).toEqual({ sql: 'SELECT * FROM table', sqlMessage: 'Syntax error' })
  })

  test('22 - WalletError.unknownToJson with WalletError', async () => {
    const werr = new WalletError('WERR_TEST', 'Test message')
    const json = WalletError.unknownToJson(werr)
    const parsed = JSON.parse(json)
    expect(parsed.name).toBe('WERR_TEST')
    expect(parsed.message).toBe('Test message')
  })

  test('23 - WalletError.unknownToJson with standard Error', async () => {
    const err = new Error('Standard error')
    const json = WalletError.unknownToJson(err)
    const werr = WalletErrorFromJson(JSON.parse(json))
    expect(werr.name).toBe('Error')
    expect(werr.message).toBe('Standard error')
  })

  test('24 - WalletError.unknownToJson with string', async () => {
    const json = WalletError.unknownToJson('String error')
    const werr = WalletErrorFromJson(JSON.parse(json))
    expect(werr.name).toBe('WERR_UNKNOWN')
    expect(werr.message).toBe('String error')
  })

  test('25 - WalletError asStatus method', async () => {
    const werr = new WalletError('WERR_TEST', 'Test description')
    const status = werr.asStatus()
    expect(status).toEqual({
      status: 'error',
      code: 'WERR_TEST',
      description: 'Test description'
    })
  })
})
