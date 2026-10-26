import {
  assertCanonicalShamirShare,
  isCanonicalShamirShare,
  validateWABCompleteAuthResponse,
  validateWABFaucetResponse,
  validateWABLinkedMethodsResponse,
  validateWABOperationResponse,
  validateWABRegistrationResponse,
  validateWABRetrieveShareResponse,
  validateWABServerInfo,
  validateWABStartAuthResponse,
  validateWABStoreShareResponse,
  validateWABUpdateShareResponse
} from '../WABResponseValidation'
import { WABClientError } from '../WABTransport'

const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)
const SHARE = '1.2.2.deadbeef'

function expectInvalid(run: () => unknown, operation: string): void {
  let error: unknown
  try {
    run()
  } catch (cause) {
    error = cause
  }
  expect(error).toBeInstanceOf(WABClientError)
  expect(error).toMatchObject({ code: 'WAB_INVALID_RESPONSE', operation })
}

describe('WAB response validation boundaries', () => {
  it.each([
    ['non-string', 1],
    ['oversized', '1'.repeat(257)],
    ['missing component', '1.2.2'],
    ['extra component', '1.2.2.deadbeef.extra'],
    ['non-base58 x', '0.2.2.deadbeef'],
    ['non-base58 y', '1.O.2.deadbeef'],
    ['non-canonical x', '11.2.2.deadbeef'],
    ['threshold below range', '1.2.1.deadbeef'],
    ['threshold above range', '1.2.256.deadbeef'],
    ['threshold with leading zero', '1.2.02.deadbeef'],
    ['uppercase integrity tag', '1.2.2.DEADBEEF'],
    ['short integrity tag', '1.2.2.deadbee']
  ])('rejects a %s Shamir share', (_name, value) => {
    expect(isCanonicalShamirShare(value)).toBe(false)
    expect(() => assertCanonicalShamirShare(value, 'shareB')).toThrow(
      'shareB must be a canonical bounded Shamir backup share.'
    )
  })

  it.each([SHARE, 'z'.repeat(64) + '.' + 'y'.repeat(64) + '.255.deadbeef'])(
    'accepts the canonical Shamir share %s',
    share => {
      expect(isCanonicalShamirShare(share)).toBe(true)
      expect(() => assertCanonicalShamirShare(share, 'shareB')).not.toThrow()
    }
  )

  it('copies a valid generic response and accepts the message boundary', () => {
    const source = { success: false, message: 'm'.repeat(4096), extension: 7 }
    const result = validateWABOperationResponse(source, 'delete-user')

    expect(result).toEqual(source)
    expect(result).not.toBe(source)
    expect(validateWABStartAuthResponse({ success: true })).toEqual({ success: true })
  })

  it.each([
    ['null response', null],
    ['array response', []],
    ['missing success', {}],
    ['coerced success', { success: 1 }],
    ['non-string message', { success: true, message: 1 }],
    ['oversized message', { success: true, message: 'm'.repeat(4097) }],
    ['C0 control in message', { success: true, message: 'accepted\nforged' }],
    ['C1 control in message', { success: true, message: `accepted${String.fromCharCode(0x85)}forged` }]
  ])('rejects a generic response with %s', (_name, response) => {
    expectInvalid(() => validateWABOperationResponse(response, 'delete-user'), 'delete-user')
  })

  it('accepts bounded server information and snapshots its method list', () => {
    const methods = ['TwilioPhone', 'dev_console-2']
    const result = validateWABServerInfo({
      supportedAuthMethods: methods,
      faucetEnabled: false,
      faucetAmount: Number.MAX_SAFE_INTEGER
    })

    expect(result).toEqual({
      supportedAuthMethods: methods,
      faucetEnabled: false,
      faucetAmount: Number.MAX_SAFE_INTEGER
    })
    expect(result.supportedAuthMethods).not.toBe(methods)
    expect(validateWABServerInfo({})).toEqual({})
  })

  it('accepts exactly 256 supported authentication methods', () => {
    const methods = Array.from({ length: 256 }, (_, index) => `m${index}`)
    expect(validateWABServerInfo({ supportedAuthMethods: methods }).supportedAuthMethods).toEqual(methods)
  })

  it.each([
    ['non-array methods', { supportedAuthMethods: 'TwilioPhone' }],
    ['too many methods', { supportedAuthMethods: Array.from({ length: 257 }, () => 'method') }],
    [
      'sparse methods',
      {
        supportedAuthMethods: (() => {
          const methods: string[] = []
          methods.length = 1
          return methods
        })()
      }
    ],
    ['non-string method', { supportedAuthMethods: [1] }],
    ['empty method', { supportedAuthMethods: [''] }],
    ['oversized method', { supportedAuthMethods: ['m'.repeat(65)] }],
    ['punctuated method', { supportedAuthMethods: ['phone/email'] }],
    ['coerced faucet flag', { faucetEnabled: 1 }],
    ['negative faucet amount', { faucetAmount: -1 }],
    ['fractional faucet amount', { faucetAmount: 1.5 }],
    ['unsafe faucet amount', { faucetAmount: Number.MAX_SAFE_INTEGER + 1 }]
  ])('rejects server information with %s', (_name, response) => {
    expectInvalid(() => validateWABServerInfo(response), 'get-info')
  })

  it('validates and snapshots every linked-method field', () => {
    const authMethods = [
      {
        id: 1,
        userId: null,
        methodType: 'TwilioPhone',
        config: 'c'.repeat(16 * 1024),
        receivedFaucet: false,
        createdAt: 'created',
        updatedAt: 'updated'
      },
      { id: Number.MAX_SAFE_INTEGER, userId: 2, methodType: 'DevConsole' }
    ]
    const result = validateWABLinkedMethodsResponse({ authMethods, message: 'ok' })

    expect(result.success).toBe(true)
    expect(result.authMethods).toEqual(authMethods)
    expect(result.authMethods).not.toBe(authMethods)
    expect(result.authMethods[0]).not.toBe(authMethods[0])
    expect(validateWABLinkedMethodsResponse({ success: false, authMethods: [] }).success).toBe(false)
  })

  it.each([
    ['missing methods', {}],
    ['non-array methods', { authMethods: {} }],
    ['too many methods', { authMethods: Array.from({ length: 257 }, () => ({ id: 1, methodType: 'm' })) }],
    [
      'sparse methods',
      {
        authMethods: (() => {
          const methods: unknown[] = []
          methods.length = 1
          return methods
        })()
      }
    ],
    ['non-record method', { authMethods: [null] }],
    ['missing id', { authMethods: [{ methodType: 'm' }] }],
    ['zero id', { authMethods: [{ id: 0, methodType: 'm' }] }],
    ['fractional id', { authMethods: [{ id: 1.5, methodType: 'm' }] }],
    ['unsafe id', { authMethods: [{ id: Number.MAX_SAFE_INTEGER + 1, methodType: 'm' }] }],
    ['missing method type', { authMethods: [{ id: 1 }] }],
    ['invalid method type', { authMethods: [{ id: 1, methodType: '../phone' }] }],
    ['zero user ID', { authMethods: [{ id: 1, methodType: 'm', userId: 0 }] }],
    ['fractional user ID', { authMethods: [{ id: 1, methodType: 'm', userId: 1.5 }] }],
    ['oversized config', { authMethods: [{ id: 1, methodType: 'm', config: 'c'.repeat(16 * 1024 + 1) }] }],
    ['control-bearing config', { authMethods: [{ id: 1, methodType: 'm', config: 'a\tb' }] }],
    ['coerced faucet flag', { authMethods: [{ id: 1, methodType: 'm', receivedFaucet: 0 }] }],
    ['oversized created time', { authMethods: [{ id: 1, methodType: 'm', createdAt: 'c'.repeat(129) }] }],
    ['control-bearing updated time', { authMethods: [{ id: 1, methodType: 'm', updatedAt: 'a\nb' }] }],
    ['coerced success', { success: 1, authMethods: [] }],
    ['control-bearing message', { authMethods: [], message: 'ok\rforged' }]
  ])('rejects linked-method data with %s', (_name, response) => {
    expectInvalid(() => validateWABLinkedMethodsResponse(response), 'list-linked-methods')
  })

  it('accepts both negative faucet verdicts and bounded payment data', () => {
    expect(validateWABFaucetResponse({ success: false })).toEqual({ success: false })
    const paymentData = {
      k: 'f'.repeat(64),
      txid: KEY_A,
      tx: [0, 255],
      amount: Number.MAX_SAFE_INTEGER,
      outputIndex: 0xffffffff
    }
    const result = validateWABFaucetResponse({ success: true, paymentData })

    expect(result).toEqual({ success: true, paymentData })
    expect(result.paymentData?.tx).not.toBe(paymentData.tx)
  })

  it.each([
    ['missing successful payment data', { success: true }],
    ['null payment data', { success: true, paymentData: null }],
    ['missing scalar', { success: true, paymentData: { txid: KEY_A, tx: [1] } }],
    ['empty scalar', { success: true, paymentData: { k: '', txid: KEY_A, tx: [1] } }],
    ['oversized scalar', { success: true, paymentData: { k: 'f'.repeat(65), txid: KEY_A, tx: [1] } }],
    ['non-hex scalar', { success: true, paymentData: { k: 'xyz', txid: KEY_A, tx: [1] } }],
    ['missing txid', { success: true, paymentData: { k: '1', tx: [1] } }],
    ['short txid', { success: true, paymentData: { k: '1', txid: 'a', tx: [1] } }],
    ['missing transaction', { success: true, paymentData: { k: '1', txid: KEY_A } }],
    ['empty transaction', { success: true, paymentData: { k: '1', txid: KEY_A, tx: [] } }],
    [
      'sparse transaction',
      {
        success: true,
        paymentData: {
          k: '1',
          txid: KEY_A,
          tx: (() => {
            const tx: number[] = []
            tx.length = 1
            return tx
          })()
        }
      }
    ],
    ['negative byte', { success: true, paymentData: { k: '1', txid: KEY_A, tx: [-1] } }],
    ['fractional byte', { success: true, paymentData: { k: '1', txid: KEY_A, tx: [1.5] } }],
    ['oversized byte', { success: true, paymentData: { k: '1', txid: KEY_A, tx: [256] } }],
    ['zero amount', { success: true, paymentData: { k: '1', txid: KEY_A, tx: [1], amount: 0 } }],
    ['fractional amount', { success: true, paymentData: { k: '1', txid: KEY_A, tx: [1], amount: 1.5 } }],
    [
      'unsafe amount',
      { success: true, paymentData: { k: '1', txid: KEY_A, tx: [1], amount: Number.MAX_SAFE_INTEGER + 1 } }
    ],
    ['negative output index', { success: true, paymentData: { k: '1', txid: KEY_A, tx: [1], outputIndex: -1 } }],
    ['fractional output index', { success: true, paymentData: { k: '1', txid: KEY_A, tx: [1], outputIndex: 1.5 } }],
    [
      'oversized output index',
      { success: true, paymentData: { k: '1', txid: KEY_A, tx: [1], outputIndex: 0x100000000 } }
    ]
  ])('rejects faucet data with %s', (_name, response) => {
    expectInvalid(() => validateWABFaucetResponse(response), 'request-faucet')
  })

  it.each([undefined, 'pending', 'active'])('accepts registration status %s', registrationStatus => {
    const response = registrationStatus === undefined ? { success: true } : { success: true, registrationStatus }
    expect(validateWABRegistrationResponse(response)).toEqual(response)
  })

  it('rejects an unknown registration status', () => {
    expectInvalid(
      () => validateWABRegistrationResponse({ success: true, registrationStatus: 'complete' }),
      'finalize-registration'
    )
  })

  it.each([
    [
      'a matching new-user key',
      { success: true, presentationKey: KEY_A.toUpperCase(), accountStatus: 'new-user', existingUser: false },
      KEY_A
    ],
    [
      'a distinct existing-user key',
      {
        success: true,
        presentationKey: KEY_B,
        accountStatus: 'existing-user',
        existingUser: true,
        registrationStatus: 'active',
        umpTokenOutpoint: `${KEY_A}.4294967295`,
        pendingPresentationKey: KEY_A,
        pendingPhoneChangeId: Number.MAX_SAFE_INTEGER
      },
      KEY_A
    ],
    ['an unsuccessful response without a key', { success: false }, KEY_A],
    ['a pending response key', { success: false, presentationKey: KEY_B, registrationStatus: 'pending' }, KEY_A],
    ['status inferred from new-user boolean', { success: true, presentationKey: KEY_A, existingUser: false }, KEY_A],
    ['status inferred from existing-user boolean', { success: true, presentationKey: KEY_B, existingUser: true }, KEY_A]
  ])('accepts complete-auth response with %s', (_name, response, temporaryKey) => {
    expect(validateWABCompleteAuthResponse(response, temporaryKey)).toEqual(response)
  })

  it.each([
    ['missing successful key', { success: true }],
    ['short successful key', { success: true, presentationKey: 'a' }],
    ['malformed optional key', { success: false, presentationKey: 'a' }],
    ['unknown account status', { success: true, presentationKey: KEY_A, accountStatus: 'unknown' }],
    [
      'inconsistent account status',
      { success: true, presentationKey: KEY_A, accountStatus: 'existing-user', existingUser: false }
    ],
    ['coerced existing-user flag', { success: false, existingUser: 1 }],
    ['unknown registration status', { success: false, registrationStatus: 'complete' }],
    ['non-string UMP outpoint', { success: false, umpTokenOutpoint: 1 }],
    ['malformed UMP outpoint', { success: false, umpTokenOutpoint: `${KEY_A}:0` }],
    ['leading-zero UMP index', { success: false, umpTokenOutpoint: `${KEY_A}.01` }],
    ['oversized UMP index', { success: false, umpTokenOutpoint: `${KEY_A}.4294967296` }],
    ['unsafe UMP index', { success: false, umpTokenOutpoint: `${KEY_A}.${Number.MAX_SAFE_INTEGER}0` }],
    ['pending key without change ID', { success: false, pendingPresentationKey: KEY_A }],
    ['change ID without pending key', { success: false, pendingPhoneChangeId: 1 }],
    ['malformed pending key', { success: false, pendingPresentationKey: 'a', pendingPhoneChangeId: 1 }],
    ['zero change ID', { success: false, pendingPresentationKey: KEY_A, pendingPhoneChangeId: 0 }],
    ['fractional change ID', { success: false, pendingPresentationKey: KEY_A, pendingPhoneChangeId: 1.5 }],
    [
      'unsafe change ID',
      { success: false, pendingPresentationKey: KEY_A, pendingPhoneChangeId: Number.MAX_SAFE_INTEGER + 1 }
    ],
    ['substituted new-user key', { success: true, presentationKey: KEY_B, accountStatus: 'new-user' }],
    ['reused existing-user temporary key', { success: true, presentationKey: KEY_A, accountStatus: 'existing-user' }],
    ['substituted inferred new-user key', { success: true, presentationKey: KEY_B, existingUser: false }],
    ['reused inferred existing-user key', { success: true, presentationKey: KEY_A, existingUser: true }]
  ])('rejects complete-auth data with %s', (_name, response) => {
    expectInvalid(() => validateWABCompleteAuthResponse(response, KEY_A), 'auth-complete')
  })

  it('validates store, retrieve, and update share verdicts at their boundaries', () => {
    expect(validateWABStoreShareResponse({ success: true })).toEqual({ success: true })
    expect(validateWABStoreShareResponse({ success: true, userId: Number.MAX_SAFE_INTEGER })).toEqual({
      success: true,
      userId: Number.MAX_SAFE_INTEGER
    })
    expect(validateWABRetrieveShareResponse({ success: false })).toEqual({ success: false })
    expect(validateWABRetrieveShareResponse({ success: true, shareB: SHARE })).toEqual({
      success: true,
      shareB: SHARE
    })
    expect(validateWABUpdateShareResponse({ success: false })).toEqual({ success: false })
    expect(validateWABUpdateShareResponse({ success: true, shareVersion: 1 })).toEqual({
      success: true,
      shareVersion: 1
    })
  })

  it.each([
    ['zero stored user ID', () => validateWABStoreShareResponse({ success: true, userId: 0 }), 'store-share'],
    ['fractional stored user ID', () => validateWABStoreShareResponse({ success: true, userId: 1.5 }), 'store-share'],
    ['missing successful share', () => validateWABRetrieveShareResponse({ success: true }), 'retrieve-share'],
    [
      'malformed optional share',
      () => validateWABRetrieveShareResponse({ success: false, shareB: 'invalid' }),
      'retrieve-share'
    ],
    ['missing successful version', () => validateWABUpdateShareResponse({ success: true }), 'update-share'],
    [
      'zero successful version',
      () => validateWABUpdateShareResponse({ success: true, shareVersion: 0 }),
      'update-share'
    ]
  ])('rejects %s', (_name, run, operation) => {
    expectInvalid(run, operation)
  })
})
