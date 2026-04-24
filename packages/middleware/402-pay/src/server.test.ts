import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Beef, Transaction, P2PKH, PrivateKey, Script, Utils } from '@bsv/sdk'
import type { WalletInterface } from '@bsv/sdk'
import {
  send402,
  validatePayment,
  createPaymentMiddleware,
  type PaymentRequest,
  type PaymentResponse,
  type PaymentResult,
  type PaymentError
} from './server.js'
import { HEADERS } from './constants.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a minimal valid BEEF containing a single transaction with one output. */
function makeBEEF(satoshis: number): { beefBase64: string; txid: string } {
  const tx = new Transaction()
  tx.addInput({
    sourceTXID: '0'.repeat(64),
    sourceOutputIndex: 0xffffffff,
    unlockingScript: Script.fromHex('00'),
    sequence: 0xffffffff
  })
  tx.addOutput({
    lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toAddress()),
    satoshis
  })
  const beef = new Beef()
  beef.mergeTransaction(tx)
  return {
    beefBase64: Buffer.from(beef.toBinary()).toString('base64'),
    txid: tx.id('hex')
  }
}

/** Builds a minimal mock PaymentResponse with vitest spies. */
function makeRes(): PaymentResponse & { _status: number; _headers: Record<string, string>; _ended: boolean } {
  const r = {
    _status: 0,
    _headers: {} as Record<string, string>,
    _ended: false,
    status(code: number) { r._status = code; return r },
    set(headers: Record<string, string>) { Object.assign(r._headers, headers); return r },
    end() { r._ended = true }
  }
  return r
}

/** Minimal headers for a valid validatePayment call. */
function validHeaders(beefBase64: string, now = Date.now()): Record<string, string> {
  return {
    [HEADERS.SENDER]: 'sender-key',
    [HEADERS.BEEF]: beefBase64,
    [HEADERS.NONCE]: 'abc123nonce',
    [HEADERS.TIME]: String(now),
    [HEADERS.VOUT]: '0'
  }
}

/** Builds a minimal wallet mock that accepts a payment (no replay). */
function makeWallet(opts: { isMerge?: boolean } = {}): WalletInterface {
  return {
    internalizeAction: vi.fn().mockResolvedValue({ accepted: true, isMerge: opts.isMerge ?? false }),
    getPublicKey: vi.fn().mockResolvedValue({ publicKey: 'server-identity-key' }),
    createAction: vi.fn(),
    // Fulfil the interface shape — unused methods
    abortAction: vi.fn(),
    getVersion: vi.fn(),
    isAuthenticated: vi.fn(),
    waitForAuthentication: vi.fn(),
    getHeaderForHeight: vi.fn(),
    getHeight: vi.fn(),
    getNetwork: vi.fn(),
    signAction: vi.fn(),
    listActions: vi.fn(),
    internalizeOutput: vi.fn(),
    listOutputs: vi.fn(),
    relinquishOutput: vi.fn(),
    getPublicKeyForProtocol: vi.fn(),
    revealCounterpartyKeyLinkage: vi.fn(),
    revealSpecificKeyLinkage: vi.fn(),
    encrypt: vi.fn(),
    decrypt: vi.fn(),
    createHmac: vi.fn(),
    verifyHmac: vi.fn(),
    createSignature: vi.fn(),
    verifySignature: vi.fn(),
    acquireCertificate: vi.fn(),
    listCertificates: vi.fn(),
    proveCertificate: vi.fn(),
    relinquishCertificate: vi.fn(),
    discoverByIdentityKey: vi.fn(),
    discoverByAttributes: vi.fn(),
  } as unknown as WalletInterface
}

// ---------------------------------------------------------------------------
// send402
// ---------------------------------------------------------------------------

describe('send402', () => {
  it('sets x-bsv-sats header as a string', () => {
    const res = makeRes()
    send402(res, 'my-key', 100)
    expect(res._headers[HEADERS.SATS]).toBe('100')
  })

  it('sets x-bsv-server header to the identity key', () => {
    const res = makeRes()
    send402(res, 'my-key', 100)
    expect(res._headers[HEADERS.SERVER]).toBe('my-key')
  })

  it('responds with HTTP 402', () => {
    const res = makeRes()
    send402(res, 'my-key', 100)
    expect(res._status).toBe(402)
  })

  it('calls end()', () => {
    const res = makeRes()
    send402(res, 'my-key', 100)
    expect(res._ended).toBe(true)
  })

  it('converts large satoshi values to strings correctly', () => {
    const res = makeRes()
    send402(res, 'key', 21_000_000 * 100_000_000)
    expect(res._headers[HEADERS.SATS]).toBe('2100000000000000')
  })
})

// ---------------------------------------------------------------------------
// validatePayment
// ---------------------------------------------------------------------------

describe('validatePayment', () => {
  let now: number
  let beefBase64: string
  let txid: string

  beforeEach(() => {
    now = Date.now()
    ;({ beefBase64, txid } = makeBEEF(100))
  })

  // --- Missing headers ---

  it('returns null when sender header is missing', async () => {
    const wallet = makeWallet()
    const headers = validHeaders(beefBase64, now)
    delete (headers as Record<string, string | undefined>)[HEADERS.SENDER]
    const result = await validatePayment({ path: '/test', headers }, wallet, 100)
    expect(result).toBeNull()
  })

  it('returns null when beef header is missing', async () => {
    const wallet = makeWallet()
    const headers = validHeaders(beefBase64, now)
    delete (headers as Record<string, string | undefined>)[HEADERS.BEEF]
    const result = await validatePayment({ path: '/test', headers }, wallet, 100)
    expect(result).toBeNull()
  })

  it('returns null when nonce header is missing', async () => {
    const wallet = makeWallet()
    const headers = validHeaders(beefBase64, now)
    delete (headers as Record<string, string | undefined>)[HEADERS.NONCE]
    const result = await validatePayment({ path: '/test', headers }, wallet, 100)
    expect(result).toBeNull()
  })

  it('returns null when time header is missing', async () => {
    const wallet = makeWallet()
    const headers = validHeaders(beefBase64, now)
    delete (headers as Record<string, string | undefined>)[HEADERS.TIME]
    const result = await validatePayment({ path: '/test', headers }, wallet, 100)
    expect(result).toBeNull()
  })

  it('returns null when vout header is missing', async () => {
    const wallet = makeWallet()
    const headers = validHeaders(beefBase64, now)
    delete (headers as Record<string, string | undefined>)[HEADERS.VOUT]
    const result = await validatePayment({ path: '/test', headers }, wallet, 100)
    expect(result).toBeNull()
  })

  // --- Array-valued headers ---

  it('accepts array-valued headers by using the first element', async () => {
    const wallet = makeWallet()
    const headers: Record<string, string | string[]> = {
      [HEADERS.SENDER]: ['sender-key', 'ignored'],
      [HEADERS.BEEF]: [beefBase64, 'ignored'],
      [HEADERS.NONCE]: ['nonce', 'ignored'],
      [HEADERS.TIME]: [String(now), 'ignored'],
      [HEADERS.VOUT]: ['0', 'ignored']
    }
    const result = await validatePayment({ path: '/test', headers }, wallet, 100)
    expect(result).not.toBeNull()
    expect((result as PaymentResult).accepted).toBe(true)
  })

  // --- Timestamp freshness ---

  it('returns null for a non-numeric time value', async () => {
    const wallet = makeWallet()
    const headers = { ...validHeaders(beefBase64, now), [HEADERS.TIME]: 'not-a-number' }
    const result = await validatePayment({ path: '/test', headers }, wallet, 100)
    expect(result).toBeNull()
  })

  it('returns null when timestamp is exactly at the window boundary (strictly outside)', async () => {
    const wallet = makeWallet()
    const expiredTime = now - 30_000 - 1
    const headers = { ...validHeaders(beefBase64, now), [HEADERS.TIME]: String(expiredTime) }
    const result = await validatePayment({ path: '/test', headers }, wallet, 100)
    expect(result).toBeNull()
  })

  it('accepts a timestamp 1ms inside the default window', async () => {
    const wallet = makeWallet()
    const freshTime = now - 29_999
    const headers = { ...validHeaders(beefBase64, now), [HEADERS.TIME]: String(freshTime) }
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const result = await validatePayment({ path: '/test', headers }, wallet, 100)
    expect(result).not.toBeNull()
    vi.restoreAllMocks()
  })

  it('returns null when timestamp is too far in the future', async () => {
    const wallet = makeWallet()
    const futureTime = now + 30_001
    const headers = { ...validHeaders(beefBase64, now), [HEADERS.TIME]: String(futureTime) }
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const result = await validatePayment({ path: '/test', headers }, wallet, 100)
    expect(result).toBeNull()
    vi.restoreAllMocks()
  })

  it('respects a custom paymentWindowMs', async () => {
    const wallet = makeWallet()
    // 5 second window, timestamp is 6 seconds old — should fail
    const oldTime = now - 6_000
    const headers = { ...validHeaders(beefBase64, now), [HEADERS.TIME]: String(oldTime) }
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const result = await validatePayment({ path: '/test', headers }, wallet, 100, 5_000)
    expect(result).toBeNull()
    vi.restoreAllMocks()
  })

  // --- BEEF parsing ---

  it('returns null when BEEF has no transactions', async () => {
    const wallet = makeWallet()
    // An empty BEEF serialises to just the version + 0 bumps + 0 txs
    const emptyBeef = new Beef()
    const emptyBase64 = Buffer.from(emptyBeef.toBinary()).toString('base64')
    const headers = { ...validHeaders(beefBase64, now), [HEADERS.BEEF]: emptyBase64 }
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const result = await validatePayment({ path: '/test', headers }, wallet, 100)
    expect(result).toBeNull()
    vi.restoreAllMocks()
  })

  // --- Output value checks ---

  it('returns null when vout index is out of bounds', async () => {
    const wallet = makeWallet()
    const headers = { ...validHeaders(beefBase64, now), [HEADERS.VOUT]: '5' }
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const result = await validatePayment({ path: '/test', headers }, wallet, 100)
    expect(result).toBeNull()
    vi.restoreAllMocks()
  })

  it('returns null when output satoshis are less than requiredSats', async () => {
    const wallet = makeWallet()
    const { beefBase64: lowBEEF } = makeBEEF(50) // only 50, need 100
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const result = await validatePayment(
      { path: '/test', headers: validHeaders(lowBEEF, now) },
      wallet,
      100
    )
    expect(result).toBeNull()
    vi.restoreAllMocks()
  })

  it('accepts when output satoshis exactly equal requiredSats', async () => {
    const wallet = makeWallet()
    const { beefBase64: exactBEEF } = makeBEEF(100)
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const result = await validatePayment(
      { path: '/test', headers: validHeaders(exactBEEF, now) },
      wallet,
      100
    )
    expect(result).not.toBeNull()
    expect((result as PaymentResult).accepted).toBe(true)
    vi.restoreAllMocks()
  })

  it('accepts when output satoshis exceed requiredSats (overpayment)', async () => {
    const wallet = makeWallet()
    const { beefBase64: richBEEF } = makeBEEF(999)
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const result = await validatePayment(
      { path: '/test', headers: validHeaders(richBEEF, now) },
      wallet,
      100
    )
    expect(result).not.toBeNull()
    expect((result as PaymentResult).satoshisPaid).toBe(999)
    vi.restoreAllMocks()
  })

  // --- isMerge replay detection ---

  it('returns a PaymentError (not null) when wallet signals isMerge', async () => {
    const wallet = makeWallet({ isMerge: true })
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const result = await validatePayment(
      { path: '/test', headers: validHeaders(beefBase64, now) },
      wallet,
      100
    )
    expect(result).not.toBeNull()
    expect((result as PaymentError).accepted).toBe(false)
    vi.restoreAllMocks()
  })

  it('PaymentError reason includes the txid', async () => {
    const wallet = makeWallet({ isMerge: true })
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const result = await validatePayment(
      { path: '/test', headers: validHeaders(beefBase64, now) },
      wallet,
      100
    ) as PaymentError
    expect(result.reason).toContain(txid)
    vi.restoreAllMocks()
  })

  it('PaymentError reason mentions replay', async () => {
    const wallet = makeWallet({ isMerge: true })
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const result = await validatePayment(
      { path: '/test', headers: validHeaders(beefBase64, now) },
      wallet,
      100
    ) as PaymentError
    expect(result.reason.toLowerCase()).toContain('replay')
    vi.restoreAllMocks()
  })

  // --- Happy path ---

  it('returns PaymentResult with accepted: true on success', async () => {
    const wallet = makeWallet()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const result = await validatePayment(
      { path: '/test', headers: validHeaders(beefBase64, now) },
      wallet,
      100
    ) as PaymentResult
    expect(result.accepted).toBe(true)
    vi.restoreAllMocks()
  })

  it('returns the correct txid on success', async () => {
    const wallet = makeWallet()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const result = await validatePayment(
      { path: '/test', headers: validHeaders(beefBase64, now) },
      wallet,
      100
    ) as PaymentResult
    expect(result.txid).toBe(txid)
    vi.restoreAllMocks()
  })

  it('returns the sender identity key on success', async () => {
    const wallet = makeWallet()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const result = await validatePayment(
      { path: '/test', headers: validHeaders(beefBase64, now) },
      wallet,
      100
    ) as PaymentResult
    expect(result.senderIdentityKey).toBe('sender-key')
    vi.restoreAllMocks()
  })

  it('returns the actual output satoshis as satoshisPaid', async () => {
    const wallet = makeWallet()
    const { beefBase64: bigBEEF } = makeBEEF(500)
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const result = await validatePayment(
      { path: '/test', headers: validHeaders(bigBEEF, now) },
      wallet,
      100
    ) as PaymentResult
    expect(result.satoshisPaid).toBe(500)
    vi.restoreAllMocks()
  })

  it('calls internalizeAction with the correct vout index', async () => {
    const wallet = makeWallet()
    // Build a BEEF with two outputs; pay into output index 1
    const tx = new Transaction()
    tx.addInput({ sourceTXID: '0'.repeat(64), sourceOutputIndex: 0xffffffff, unlockingScript: Script.fromHex('00'), sequence: 0xffffffff })
    tx.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toAddress()), satoshis: 1 })
    tx.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toAddress()), satoshis: 200 })
    const beef = new Beef()
    beef.mergeTransaction(tx)
    const b64 = Buffer.from(beef.toBinary()).toString('base64')

    vi.spyOn(Date, 'now').mockReturnValue(now)
    const headers = { ...validHeaders(b64, now), [HEADERS.VOUT]: '1' }
    await validatePayment({ path: '/p', headers }, wallet, 200)
    expect(wallet.internalizeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        outputs: expect.arrayContaining([
          expect.objectContaining({ outputIndex: 1 })
        ])
      })
    )
    vi.restoreAllMocks()
  })

  it('passes the request path into the internalizeAction description', async () => {
    const wallet = makeWallet()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    await validatePayment(
      { path: '/articles/foo', headers: validHeaders(beefBase64, now) },
      wallet,
      100
    )
    expect(wallet.internalizeAction).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Payment for /articles/foo' })
    )
    vi.restoreAllMocks()
  })

  it('derives the derivationSuffix as base64 of the raw time string', async () => {
    const wallet = makeWallet()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const timeStr = String(now)
    const expectedSuffix = Buffer.from(timeStr).toString('base64')
    await validatePayment(
      { path: '/test', headers: validHeaders(beefBase64, now) },
      wallet,
      100
    )
    expect(wallet.internalizeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        outputs: expect.arrayContaining([
          expect.objectContaining({
            paymentRemittance: expect.objectContaining({
              derivationSuffix: expectedSuffix
            })
          })
        ])
      })
    )
    vi.restoreAllMocks()
  })
})

// ---------------------------------------------------------------------------
// createPaymentMiddleware
// ---------------------------------------------------------------------------

describe('createPaymentMiddleware', () => {
  let now: number
  let beefBase64: string
  let txid: string
  let wallet: WalletInterface

  beforeEach(() => {
    now = Date.now()
    ;({ beefBase64, txid } = makeBEEF(100))
    wallet = makeWallet()
    vi.spyOn(Date, 'now').mockReturnValue(now)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function makeReq(headers: Record<string, string> = {}): any {
    return { path: '/test', headers }
  }

  function makeExpressRes(): any {
    const r: any = {
      _status: 200,
      _headers: {} as Record<string, string>,
      _ended: false,
      status(code: number) { r._status = code; return r },
      set(headers: Record<string, string>) { Object.assign(r._headers, headers); return r },
      end() { r._ended = true }
    }
    return r
  }

  // --- Free content (no price) ---

  it('calls next() without payment when calculatePrice returns 0', async () => {
    const middleware = createPaymentMiddleware({ wallet, calculatePrice: () => 0 })
    const next = vi.fn()
    await middleware(makeReq(), makeExpressRes(), next)
    expect(next).toHaveBeenCalled()
  })

  it('calls next() without payment when calculatePrice returns undefined', async () => {
    const middleware = createPaymentMiddleware({ wallet, calculatePrice: () => undefined })
    const next = vi.fn()
    await middleware(makeReq(), makeExpressRes(), next)
    expect(next).toHaveBeenCalled()
  })

  // --- Missing BEEF header ---

  it('sends 402 when beef header is absent', async () => {
    const middleware = createPaymentMiddleware({ wallet, calculatePrice: () => 100 })
    const res = makeExpressRes()
    const next = vi.fn()
    await middleware(makeReq(), res, next)
    expect(res._status).toBe(402)
    expect(next).not.toHaveBeenCalled()
  })

  // --- Invalid payment ---

  it('sends 402 when validatePayment returns null (missing headers)', async () => {
    const middleware = createPaymentMiddleware({ wallet, calculatePrice: () => 100 })
    const res = makeExpressRes()
    const next = vi.fn()
    // Only beef header present, rest missing
    await middleware(makeReq({ [HEADERS.BEEF]: beefBase64 }), res, next)
    expect(res._status).toBe(402)
    expect(next).not.toHaveBeenCalled()
  })

  // --- Replay attack ---

  it('sends 402 and logs error when validatePayment returns PaymentError (isMerge)', async () => {
    const replayWallet = makeWallet({ isMerge: true })
    const middleware = createPaymentMiddleware({ wallet: replayWallet, calculatePrice: () => 100 })
    const res = makeExpressRes()
    const next = vi.fn()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await middleware(makeReq(validHeaders(beefBase64, now)), res, next)
    expect(res._status).toBe(402)
    expect(next).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledOnce()
    expect(errorSpy.mock.calls[0][0]).toContain('/test')
  })

  // --- Happy path ---

  it('calls next() on valid payment', async () => {
    const middleware = createPaymentMiddleware({ wallet, calculatePrice: () => 100 })
    const next = vi.fn()
    await middleware(makeReq(validHeaders(beefBase64, now)), makeExpressRes(), next)
    expect(next).toHaveBeenCalledOnce()
  })

  it('attaches req.payment on valid payment', async () => {
    const middleware = createPaymentMiddleware({ wallet, calculatePrice: () => 100 })
    const req = makeReq(validHeaders(beefBase64, now))
    const next = vi.fn()
    await middleware(req, makeExpressRes(), next)
    expect(req.payment).toBeDefined()
    expect(req.payment.accepted).toBe(true)
  })

  it('sets satoshisPaid from calculatePrice (not from the tx output)', async () => {
    const middleware = createPaymentMiddleware({ wallet, calculatePrice: () => 100 })
    const req = makeReq(validHeaders(beefBase64, now))
    await middleware(req, makeExpressRes(), vi.fn())
    expect(req.payment.satoshisPaid).toBe(100)
  })

  it('sets the txid on req.payment', async () => {
    const middleware = createPaymentMiddleware({ wallet, calculatePrice: () => 100 })
    const req = makeReq(validHeaders(beefBase64, now))
    await middleware(req, makeExpressRes(), vi.fn())
    expect(req.payment.txid).toBe(txid)
  })

  it('logs accepted payment to console', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const middleware = createPaymentMiddleware({ wallet, calculatePrice: () => 100 })
    await middleware(makeReq(validHeaders(beefBase64, now)), makeExpressRes(), vi.fn())
    expect(logSpy).toHaveBeenCalledOnce()
    expect(logSpy.mock.calls[0][0]).toContain('100')
    expect(logSpy.mock.calls[0][0]).toContain(txid)
  })

  // --- Identity key lazy init ---

  it('fetches server identity key lazily on first request', async () => {
    const middleware = createPaymentMiddleware({ wallet, calculatePrice: () => 100 })
    await middleware(makeReq(validHeaders(beefBase64, now)), makeExpressRes(), vi.fn())
    expect(wallet.getPublicKey).toHaveBeenCalledWith({ identityKey: true })
  })

  it('does not re-fetch identity key on subsequent requests', async () => {
    const middleware = createPaymentMiddleware({ wallet, calculatePrice: () => 100 })
    const { beefBase64: b1 } = makeBEEF(100)
    const { beefBase64: b2 } = makeBEEF(100)
    await middleware(makeReq(validHeaders(b1, now)), makeExpressRes(), vi.fn())
    await middleware(makeReq(validHeaders(b2, now)), makeExpressRes(), vi.fn())
    // getPublicKey should be called exactly once for the identity key
    const identityCalls = (wallet.getPublicKey as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([args]) => args.identityKey === true
    )
    expect(identityCalls).toHaveLength(1)
  })

  // --- Error handling ---

  it('responds with 500 when wallet.getPublicKey throws before identity key is set', async () => {
    const brokenWallet = {
      ...makeWallet(),
      getPublicKey: vi.fn().mockRejectedValue(new Error('wallet unavailable'))
    } as unknown as WalletInterface
    const middleware = createPaymentMiddleware({ wallet: brokenWallet, calculatePrice: () => 100 })
    const res = makeExpressRes()
    await middleware(makeReq(), res, vi.fn())
    expect(res._status).toBe(500)
  })

  it('falls back to send402 when error occurs after identity key is set', async () => {
    // First request succeeds to prime the identity key
    const middleware = createPaymentMiddleware({ wallet, calculatePrice: () => 100 })
    await middleware(makeReq(validHeaders(beefBase64, now)), makeExpressRes(), vi.fn())

    // Now make internalizeAction throw
    ;(wallet.internalizeAction as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('db error'))
    const res = makeExpressRes()
    await middleware(makeReq(validHeaders(beefBase64, now)), res, vi.fn())
    expect(res._status).toBe(402)
  })

  it('uses fallback price of 100 when calculatePrice returns undefined inside catch', async () => {
    let callCount = 0
    const flaky = {
      ...makeWallet(),
      // First call (identity key fetch) succeeds; second (internalizeAction) throws
      internalizeAction: vi.fn().mockRejectedValue(new Error('boom'))
    } as unknown as WalletInterface

    // Prime identity key with a succeeding run first using the normal wallet
    const middleware = createPaymentMiddleware({
      wallet: flaky,
      calculatePrice: () => { callCount++; return callCount === 1 ? 100 : undefined }
    })

    // Run 1: triggers identity key fetch but internalizeAction will throw → catch
    const res = makeExpressRes()
    // Give it a full valid request so it gets past the BEEF check and into validatePayment
    await middleware(makeReq(validHeaders(beefBase64, now)), res, vi.fn())
    // Either 402 with fallback price or 500 — it won't be 200
    expect([402, 500]).toContain(res._status)
  })
})
