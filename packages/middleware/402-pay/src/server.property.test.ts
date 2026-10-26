import fc from 'fast-check'
import { Beef, Script, Transaction } from '@bsv/sdk'
import type { WalletInterface } from '@bsv/sdk'
import * as PrimitiveUtils from '@bsv/sdk/primitives/utils'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { HEADERS } from './constants.js'
import {
  createPaymentMiddleware,
  InMemoryPaymentReplayStore,
  type PaymentLogger,
  type PaymentResponse,
  send402,
  validatePayment
} from './server.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH

fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

const identityKey = '03f8104e2b313136ef1b84fcd9c8aadb775beb89a8207c942b31ab89e160ba4c86'
const nonce = 'YWJjMTIzbm9uY2U='

function atomicBeef(satoshis: number): { encoded: string; txid: string } {
  const transaction = new Transaction()
  transaction.addInput({
    sourceTXID: '0'.repeat(64),
    sourceOutputIndex: 0xffffffff,
    unlockingScript: Script.fromHex('00'),
    sequence: 0xffffffff
  })
  transaction.addOutput({ satoshis, lockingScript: Script.fromASM('OP_TRUE') })
  const beef = new Beef()
  beef.mergeTransaction(transaction)
  const txid = transaction.id('hex')
  return {
    encoded: Buffer.from(beef.toBinaryAtomic(txid)).toString('base64'),
    txid
  }
}

function paymentHeaders(encoded: string, time: number): Record<string, string> {
  return {
    [HEADERS.SENDER]: identityKey,
    [HEADERS.BEEF]: encoded,
    [HEADERS.NONCE]: nonce,
    [HEADERS.TIME]: String(time),
    [HEADERS.VOUT]: '0'
  }
}

function walletWithVerdict(verdict: unknown = { accepted: true, isMerge: false }): WalletInterface {
  return {
    internalizeAction: vi.fn().mockResolvedValue(verdict),
    getPublicKey: vi.fn().mockResolvedValue({ publicKey: identityKey })
  } as unknown as WalletInterface
}

function expressResponse(): PaymentResponse & {
  statusCode?: number
  headers: Record<string, string>
  ended: boolean
} {
  return responseRecorder()
}

afterEach(() => {
  vi.restoreAllMocks()
})

function responseRecorder(): PaymentResponse & {
  statusCode?: number
  headers: Record<string, string>
  ended: boolean
} {
  const response = {
    statusCode: undefined as number | undefined,
    headers: {},
    ended: false,
    status(code: number) {
      response.statusCode = code
      return response
    },
    set(headers: Record<string, string>) {
      Object.assign(response.headers, headers)
      return response
    },
    end() {
      response.ended = true
    }
  }
  return response
}

describe('BRC-121 challenge boundary properties', () => {
  test('serializes every positive safe-integer price exactly', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), sats => {
        const response = responseRecorder()
        send402(response, identityKey, sats)
        expect(response).toMatchObject({
          statusCode: 402,
          headers: {
            [HEADERS.SATS]: String(sats),
            [HEADERS.SERVER]: identityKey
          },
          ended: true
        })
      })
    )
  })

  test('rejects arbitrary non-positive or unsafe prices before mutating the response', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: Number.MIN_SAFE_INTEGER, max: 0 }),
          fc.constant(Number.MAX_SAFE_INTEGER + 1),
          fc.constant(Number.NaN),
          fc.constant(Number.POSITIVE_INFINITY)
        ),
        sats => {
          const response = responseRecorder()
          expect(() => send402(response, identityKey, sats)).toThrow(RangeError)
          expect(response).toMatchObject({ statusCode: undefined, headers: {}, ended: false })
        }
      )
    )
  })

  test('rejects arbitrary invalid identity material before issuing a challenge', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 65 }), candidate => {
        const response = responseRecorder()
        expect(() => send402(response, candidate, 1)).toThrow(TypeError)
        expect(response).toMatchObject({ statusCode: undefined, headers: {}, ended: false })
      })
    )
  })
})

describe('payment server trust-boundary mutations', () => {
  const txidA = 'a'.repeat(64)
  const txidB = 'b'.repeat(64)

  test('replay-store configuration, keys, clocks, and expiry boundaries fail closed', () => {
    for (const capacity of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new InMemoryPaymentReplayStore(capacity)).toThrow(
        'Replay-store capacity must be a positive safe integer'
      )
    }

    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const store = new InMemoryPaymentReplayStore(1)
    for (const candidate of ['', txidA.slice(1), `${txidA}0`, `0${txidA}`, txidA.toUpperCase()]) {
      expect(() => store.claim(candidate, 2_000)).toThrow(
        'Replay claims require a canonical transaction ID'
      )
    }
    for (const expiry of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => store.claim(txidA, expiry)).toThrow(
        'Replay claims require a safe expiration timestamp'
      )
    }

    expect(store.claim(txidA, 1_000)).toBe(true)
    expect(store.claim(txidA, 1_000)).toBe(false)
    expect(() => store.claim(txidB, 2_000)).toThrow('Payment replay store capacity exceeded')

    clock.mockReturnValue(1_001)
    expect(store.claim(txidB, 2_000)).toBe(true)
    for (const invalidNow of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      clock.mockReturnValue(invalidNow)
      expect(() => new InMemoryPaymentReplayStore().claim(txidA, 2_000)).toThrow(
        'The system clock is outside the supported range'
      )
    }
  })

  test('middleware rejects every malformed dependency and accepts valid optional loggers', () => {
    const wallet = walletWithVerdict()
    const calculatePrice = () => 1
    const requiredOptionsError = 'Payment middleware options are required'
    expect(() => createPaymentMiddleware(null as never)).toThrow(requiredOptionsError)
    expect(() => createPaymentMiddleware(undefined as never)).toThrow(requiredOptionsError)
    expect(() => createPaymentMiddleware('options' as never)).toThrow(requiredOptionsError)

    for (const candidate of [null, {}, { internalizeAction: null }]) {
      expect(() => createPaymentMiddleware({ wallet: candidate, calculatePrice } as never)).toThrow(
        'A valid wallet instance is required'
      )
    }
    expect(() => createPaymentMiddleware({ wallet, calculatePrice: 1 as never })).toThrow(
      'calculatePrice must be a function'
    )
    for (const paymentWindowMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createPaymentMiddleware({ wallet, calculatePrice, paymentWindowMs })).toThrow(
        'paymentWindowMs must be a positive safe integer'
      )
    }
    for (const replayStore of [{}, { claim: null }]) {
      expect(() =>
        createPaymentMiddleware({ wallet, calculatePrice, replayStore } as never)
      ).toThrow('A replay store with an atomic claim method is required')
    }
    for (const logger of [null, 'logger', { error: true }, { warn: true }, { info: true }]) {
      expect(() => createPaymentMiddleware({ wallet, calculatePrice, logger } as never)).toThrow(
        'logger methods must be functions when provided'
      )
    }

    for (const logger of [
      {},
      { error: vi.fn() },
      { warn: vi.fn() },
      { info: vi.fn() },
      { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
    ]) {
      expect(() => createPaymentMiddleware({ wallet, calculatePrice, logger })).not.toThrow()
    }
  })

  test('diagnostics report bounded error shapes and never control the response', async () => {
    const ordinaryLogger: PaymentLogger = { error: vi.fn() }
    const ordinaryWallet = walletWithVerdict()
    vi.mocked(ordinaryWallet.getPublicKey).mockRejectedValueOnce(new Error('secret details'))
    const ordinaryResponse = expressResponse()
    await createPaymentMiddleware({
      wallet: ordinaryWallet,
      calculatePrice: () => 1,
      logger: ordinaryLogger
    })({ path: '/private', headers: {} }, ordinaryResponse, vi.fn())
    expect(ordinaryLogger.error).toHaveBeenCalledWith('Payment identity initialization failed.', {
      errorName: 'Error'
    })
    expect(ordinaryResponse).toMatchObject({ statusCode: 500, ended: true })

    const hostileError = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('prototype trap')
        }
      }
    )
    const hostileLogger: PaymentLogger = { error: vi.fn() }
    const hostileWallet = walletWithVerdict()
    vi.mocked(hostileWallet.getPublicKey).mockRejectedValueOnce(hostileError)
    await createPaymentMiddleware({
      wallet: hostileWallet,
      calculatePrice: () => 1,
      logger: hostileLogger
    })({ path: '/', headers: {} }, expressResponse(), vi.fn())
    expect(hostileLogger.error).toHaveBeenCalledWith('Payment identity initialization failed.', {
      errorType: 'unknown'
    })

    const pricingLogger: PaymentLogger = {
      error: vi.fn(() => {
        throw new Error('diagnostic sink failed')
      })
    }
    const pricingResponse = expressResponse()
    await createPaymentMiddleware({
      wallet: walletWithVerdict(),
      calculatePrice: () => {
        throw { confidential: true }
      },
      logger: pricingLogger
    })({ path: '/secret', headers: {} }, pricingResponse, vi.fn())
    expect(pricingLogger.error).toHaveBeenCalledWith('Payment pricing failed.', {
      errorType: 'object'
    })
    expect(pricingResponse).toMatchObject({ statusCode: 500, ended: true })
  })

  test('a valid payment preserves every authenticated value and exact wallet request', async () => {
    const now = 1_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const { encoded, txid } = atomicBeef(125)
    const wallet = walletWithVerdict({ accepted: true })
    const claim = vi.fn().mockReturnValue(true)

    const result = await validatePayment(
      { path: '/untrusted/path', headers: paymentHeaders(encoded, now) },
      wallet,
      100,
      30_000,
      { claim }
    )

    expect(result).toEqual({
      accepted: true,
      satoshisPaid: 125,
      senderIdentityKey: identityKey,
      txid
    })
    expect(wallet.internalizeAction).toHaveBeenCalledWith({
      tx: expect.any(Array),
      outputs: [
        {
          outputIndex: 0,
          protocol: 'wallet payment',
          paymentRemittance: {
            derivationPrefix: nonce,
            derivationSuffix: Buffer.from(String(now)).toString('base64'),
            senderIdentityKey: identityKey
          }
        }
      ],
      description: 'BRC-121 payment'
    })
    expect(claim).toHaveBeenCalledWith(txid, now + 30_000)
  })

  test('wallet verdicts require own boolean data properties without invoking traps', async () => {
    const now = 2_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const { encoded, txid } = atomicBeef(100)
    const headers = paymentHeaders(encoded, now)
    const getter = vi.fn(() => true)
    const trappedAccepted = Object.defineProperty({}, 'accepted', { get: getter })
    const trappedMerge = Object.defineProperty({ accepted: true }, 'isMerge', { get: getter })
    const descriptorTrap = new Proxy(
      { accepted: true },
      {
        getOwnPropertyDescriptor() {
          throw new Error('descriptor trap')
        }
      }
    )
    const inherited = Object.create({ accepted: true, isMerge: false })
    const rejectedVerdicts = [
      null,
      [],
      true,
      inherited,
      trappedAccepted,
      trappedMerge,
      descriptorTrap,
      { accepted: false },
      { accepted: true, isMerge: 'false' },
      { accepted: true, isMerge: undefined }
    ]

    for (const verdict of rejectedVerdicts) {
      const wallet = walletWithVerdict(verdict)
      const claim = vi.fn().mockReturnValue(true)
      await expect(
        validatePayment({ path: '/', headers }, wallet, 100, 30_000, { claim })
      ).resolves.toEqual({
        accepted: false,
        reason: `Wallet rejected transaction: txid ${txid}`
      })
      expect(claim).not.toHaveBeenCalled()
    }
    expect(getter).not.toHaveBeenCalled()

    await expect(
      validatePayment(
        { path: '/', headers },
        walletWithVerdict({ accepted: true, isMerge: true }),
        100,
        30_000,
        { claim: vi.fn() }
      )
    ).resolves.toEqual({
      accepted: false,
      reason: `Replayed transaction: txid ${txid} has already been processed`
    })
  })

  test('replay claims require an exact affirmative boolean verdict', async () => {
    const now = 3_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const { encoded, txid } = atomicBeef(100)
    const request = { path: '/', headers: paymentHeaders(encoded, now) }

    await expect(
      validatePayment(request, walletWithVerdict(), 100, 30_000, {
        claim: vi.fn().mockResolvedValue(false)
      })
    ).resolves.toEqual({
      accepted: false,
      reason: `Replayed transaction: txid ${txid} has already been processed`
    })
    await expect(
      validatePayment(request, walletWithVerdict(), 100, 30_000, {
        claim: vi.fn().mockResolvedValue('true' as never)
      })
    ).rejects.toThrow('The payment replay store returned an invalid claim verdict')
  })

  test('header syntax, ownership, and exact-size boundaries are enforced before wallet work', async () => {
    const now = 4_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const { encoded } = atomicBeef(100)
    const valid = paymentHeaders(encoded, now)
    const malformed: Array<[string, string | string[] | undefined]> = [
      [HEADERS.SENDER, undefined],
      [HEADERS.SENDER, [identityKey]],
      [HEADERS.SENDER, `${identityKey}0`],
      [HEADERS.SENDER, `0${identityKey}`],
      [HEADERS.SENDER, `02${'f'.repeat(64)}`],
      [HEADERS.BEEF, `${encoded}!`],
      [HEADERS.BEEF, `!${encoded}`],
      [HEADERS.NONCE, `${nonce}A`],
      [HEADERS.NONCE, `!${nonce}`],
      [HEADERS.TIME, '00'],
      [HEADERS.TIME, '1e3'],
      [HEADERS.TIME, String(Number.MAX_SAFE_INTEGER + 1)],
      [HEADERS.VOUT, '-1'],
      [HEADERS.VOUT, '00'],
      [HEADERS.VOUT, '0suffix']
    ]
    for (const [header, value] of malformed) {
      const wallet = walletWithVerdict()
      const headers: Record<string, string | string[] | undefined> = { ...valid, [header]: value }
      await expect(validatePayment({ path: '/', headers }, wallet, 100)).resolves.toBeNull()
      expect(wallet.internalizeAction).not.toHaveBeenCalled()
    }

    const exactNonceWallet = walletWithVerdict()
    await expect(
      validatePayment(
        {
          path: '/',
          headers: { ...valid, [HEADERS.NONCE]: 'A'.repeat(512) }
        },
        exactNonceWallet,
        100,
        30_000,
        { claim: vi.fn().mockReturnValue(true) }
      )
    ).resolves.toMatchObject({ accepted: true })

    const sixteenDigitTime = 1_000_000_000_000_000
    vi.mocked(Date.now).mockReturnValue(sixteenDigitTime)
    await expect(
      validatePayment(
        { path: '/', headers: paymentHeaders(encoded, sixteenDigitTime) },
        walletWithVerdict(),
        100,
        1,
        { claim: vi.fn().mockReturnValue(true) }
      )
    ).resolves.toMatchObject({ accepted: true })
  })

  test('timestamp and amount comparisons preserve their inclusive safe boundaries', async () => {
    const now = 5_000_000
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const { encoded } = atomicBeef(100)
    for (const timestamp of [now - 30_000, now + 30_000]) {
      await expect(
        validatePayment(
          { path: '/', headers: paymentHeaders(encoded, timestamp) },
          walletWithVerdict(),
          100,
          30_000,
          { claim: vi.fn().mockReturnValue(true) }
        )
      ).resolves.toMatchObject({ accepted: true })
    }

    const maximumTimestamp = Number.MAX_SAFE_INTEGER - 1
    clock.mockReturnValue(maximumTimestamp)
    await expect(
      validatePayment(
        { path: '/', headers: paymentHeaders(encoded, maximumTimestamp) },
        walletWithVerdict(),
        100,
        1,
        { claim: vi.fn().mockReturnValue(true) }
      )
    ).resolves.toMatchObject({ accepted: true })

    clock.mockReturnValue(0)
    await expect(
      validatePayment(
        { path: '/', headers: paymentHeaders(encoded, 0) },
        walletWithVerdict(),
        100,
        1,
        { claim: vi.fn().mockReturnValue(true) }
      )
    ).resolves.toMatchObject({ accepted: true })

    for (const invalidClock of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const wallet = walletWithVerdict()
      clock.mockReturnValue(invalidClock)
      await expect(
        validatePayment({ path: '/', headers: paymentHeaders(encoded, 0) }, wallet, 100, 1)
      ).resolves.toBeNull()
      expect(wallet.internalizeAction).not.toHaveBeenCalled()
    }

    clock.mockReturnValue(now)
    for (const requiredSats of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        validatePayment(
          { path: '/', headers: paymentHeaders(encoded, now) },
          walletWithVerdict(),
          requiredSats
        )
      ).resolves.toBeNull()
    }
    for (const paymentWindowMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        validatePayment(
          { path: '/', headers: paymentHeaders(encoded, now) },
          walletWithVerdict(),
          100,
          paymentWindowMs
        )
      ).resolves.toBeNull()
    }
  })

  test('malformed atomic envelopes and output selections never reach the wallet', async () => {
    const now = 6_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const valid = atomicBeef(100)
    const plainBeef = new Beef()
    const plainTransaction = new Transaction()
    plainTransaction.addOutput({ satoshis: 100, lockingScript: Script.fromASM('OP_TRUE') })
    plainBeef.mergeTransaction(plainTransaction)
    const malformedEnvelopes = [
      Buffer.from(plainBeef.toBinary()).toString('base64'),
      Buffer.concat([Buffer.from(valid.encoded, 'base64'), Buffer.from([0xaa])]).toString('base64')
    ]
    for (const encoded of malformedEnvelopes) {
      const wallet = walletWithVerdict()
      await expect(
        validatePayment({ path: '/', headers: paymentHeaders(encoded, now) }, wallet, 100)
      ).resolves.toBeNull()
      expect(wallet.internalizeAction).not.toHaveBeenCalled()
    }

    const low = atomicBeef(99)
    for (const [encoded, vout] of [
      [low.encoded, '0'],
      [valid.encoded, '1']
    ]) {
      const wallet = walletWithVerdict()
      await expect(
        validatePayment(
          { path: '/', headers: { ...paymentHeaders(encoded, now), [HEADERS.VOUT]: vout } },
          wallet,
          100
        )
      ).resolves.toBeNull()
      expect(wallet.internalizeAction).not.toHaveBeenCalled()
    }
  })

  test('base64 decoder failures remain a malformed-payment result', async () => {
    const now = 7_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const { encoded } = atomicBeef(100)
    const originalToArray = PrimitiveUtils.toArray
    vi.spyOn(PrimitiveUtils, 'toArray').mockImplementation((value, encoding) => {
      if (value === nonce && encoding === 'base64') throw new Error('decoder failed')
      return originalToArray(value, encoding)
    })
    const wallet = walletWithVerdict()

    await expect(
      validatePayment({ path: '/', headers: paymentHeaders(encoded, now) }, wallet, 100)
    ).resolves.toBeNull()
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
  })

  test('middleware produces exact free, challenge, rejection, success, and failure outcomes', async () => {
    const now = 8_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const { encoded, txid } = atomicBeef(125)

    for (const price of [0, undefined]) {
      const next = vi.fn()
      const response = expressResponse()
      await createPaymentMiddleware({
        wallet: walletWithVerdict(),
        calculatePrice: () => price
      })({ path: '/', headers: {} }, response, next)
      expect(next).toHaveBeenCalledOnce()
      expect(response.ended).toBe(false)
    }

    for (const price of [-1, 1.5, Number.POSITIVE_INFINITY]) {
      const response = expressResponse()
      await createPaymentMiddleware({
        wallet: walletWithVerdict(),
        calculatePrice: () => price
      })({ path: '/', headers: {} }, response, vi.fn())
      expect(response).toMatchObject({ statusCode: 500, ended: true })
    }

    const challengeResponse = expressResponse()
    await createPaymentMiddleware({
      wallet: walletWithVerdict(),
      calculatePrice: () => 100
    })({ path: '/', headers: {} }, challengeResponse, vi.fn())
    expect(challengeResponse).toMatchObject({
      statusCode: 402,
      headers: { [HEADERS.SATS]: '100', [HEADERS.SERVER]: identityKey },
      ended: true
    })

    const acceptedLogger: PaymentLogger = { info: vi.fn() }
    const acceptedRequest: Record<string, unknown> = {
      path: '/',
      headers: paymentHeaders(encoded, now)
    }
    const acceptedNext = vi.fn()
    await createPaymentMiddleware({
      wallet: walletWithVerdict(),
      calculatePrice: () => 100,
      replayStore: { claim: vi.fn().mockReturnValue(true) },
      logger: acceptedLogger
    })(acceptedRequest, expressResponse(), acceptedNext)
    expect(acceptedRequest.payment).toEqual({
      accepted: true,
      satoshisPaid: 125,
      senderIdentityKey: identityKey,
      txid
    })
    expect(acceptedLogger.info).toHaveBeenCalledWith('Payment accepted.', {
      satoshisPaid: 125,
      txid
    })
    expect(acceptedNext).toHaveBeenCalledOnce()

    const rejectedLogger: PaymentLogger = { warn: vi.fn() }
    const rejectedResponse = expressResponse()
    await createPaymentMiddleware({
      wallet: walletWithVerdict({ accepted: true, isMerge: true }),
      calculatePrice: () => 100,
      logger: rejectedLogger
    })({ path: '/', headers: paymentHeaders(encoded, now) }, rejectedResponse, vi.fn())
    expect(rejectedLogger.warn).toHaveBeenCalledWith('Payment rejected.')
    expect(rejectedResponse.statusCode).toBe(402)

    const failedLogger: PaymentLogger = { error: vi.fn() }
    const failedWallet = walletWithVerdict()
    vi.mocked(failedWallet.internalizeAction).mockRejectedValueOnce(new Error('ambiguous'))
    const failedResponse = expressResponse()
    await createPaymentMiddleware({
      wallet: failedWallet,
      calculatePrice: () => 100,
      logger: failedLogger
    })({ path: '/', headers: paymentHeaders(encoded, now) }, failedResponse, vi.fn())
    expect(failedLogger.error).toHaveBeenCalledWith('Payment validation failed.', {
      errorName: 'Error'
    })
    expect(failedResponse).toMatchObject({ statusCode: 503, headers: {}, ended: true })
  })
})
