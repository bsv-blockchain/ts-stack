import { beforeAll, describe, expect, it, jest } from '@jest/globals'
import { P2PKH, PrivateKey, ProtoWallet, PublicKey, Transaction } from '@bsv/sdk'
import { makePaymentTx } from './helpers/tx.js'
import {
  MAX_DIRECT_TRANSACTION_BYTES,
  decodePayment,
  encodePayment,
  parseWireMessage,
  validatePaymentToken
} from '../src/payments/wire.js'
import type { PaymentWire, WireMessage } from '../src/payments/wire.js'
import { acceptDirectPayment, paymentKey, verifyDirectPayment } from '../src/payments/accept.js'
import type { SeenStore } from '../src/payments/accept.js'
import {
  createPaymentRequestProof,
  normalizePaymentRequest,
  normalizePaymentRequestResponse,
  verifyPaymentRequestProof
} from '../src/payments/requests.js'
import { DEFAULTS, PAYMENT_PROTOCOL_ID } from '../src/types.js'
import type {
  IncomingPayment,
  PaymentRequestMessage,
  PaymentToken,
  PaymentTokenInput,
  WalletLike
} from '../src/types.js'
import { randomBytes, toBase64, toHex, utf8Encode } from '../src/util/bytes.js'
import { WebRTPayError } from '../src/util/errors.js'

// ---------------------------------------------------------------- helpers

/** The error code a call throws: a WebRTPayError code, 'other:<message>', or 'none'. */
function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    return e instanceof WebRTPayError ? e.code : `other:${String(e)}`
  }
  return 'none'
}

async function asyncCodeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (e) {
    return e instanceof WebRTPayError ? e.code : `other:${String(e)}`
  }
  return 'none'
}

interface TestWallet {
  wallet: WalletLike
  identityKey: string
  internalizeAction: ReturnType<typeof jest.fn<WalletLike['internalizeAction']>>
}

/** A ProtoWallet (real key derivation and HMACs) with a jest-mocked internalizeAction. */
async function makeWallet(): Promise<TestWallet> {
  const internalizeAction = jest.fn<WalletLike['internalizeAction']>(async () => ({
    accepted: true
  }))
  const wallet: WalletLike = Object.assign(new ProtoWallet(PrivateKey.fromRandom()), {
    internalizeAction
  })
  const { publicKey } = await wallet.getPublicKey({ identityKey: true })
  return { wallet, identityKey: publicKey, internalizeAction }
}

/** A payer-built token paying `satoshis` to the payee's BRC-29 derived key at output 0. */
async function makeToken(
  payer: TestWallet,
  payeeKey: string,
  satoshis: number
): Promise<{ token: PaymentToken; txid: string }> {
  const derivationPrefix = toBase64(randomBytes(32))
  const derivationSuffix = toBase64(randomBytes(32))
  const { publicKey } = await payer.wallet.getPublicKey({
    protocolID: PAYMENT_PROTOCOL_ID,
    keyID: `${derivationPrefix} ${derivationSuffix}`,
    counterparty: payeeKey
  })
  const { beef, txid } = makePaymentTx(PublicKey.fromString(publicKey), satoshis)
  return {
    token: {
      customInstructions: { derivationPrefix, derivationSuffix },
      transaction: beef,
      amount: satoshis,
      outputIndex: 0
    },
    txid
  }
}

function memorySeen(): SeenStore & { keys: Set<string> } {
  const keys = new Set<string>()
  return {
    keys,
    has: key => keys.has(key),
    add: key => {
      keys.add(key)
    }
  }
}

/** A wire payment as it arrives from a peer: JSON-encoded and parsed again. */
function overTheWire(w: PaymentWire): PaymentWire {
  return JSON.parse(JSON.stringify(w)) as PaymentWire
}

/** A valid payment wire with one token field (or the note) replaced. */
function withTokenField(w: PaymentWire, field: string, value: unknown): PaymentWire {
  return { ...w, token: { ...w.token, [field]: value } } as unknown as PaymentWire
}

function withDerivation(w: PaymentWire, field: string, value: unknown): PaymentWire {
  return {
    ...w,
    token: { ...w.token, customInstructions: { ...w.token.customInstructions, [field]: value } }
  } as unknown as PaymentWire
}

const IDENTITY_KEY = PrivateKey.fromRandom().toPublicKey().toString()
const TXID = 'ab'.repeat(32)
const PROOF = 'cd'.repeat(32)

// ---------------------------------------------------------------- tests

describe('makePaymentTx', () => {
  it('builds Atomic BEEF that parses offline and pays the key', () => {
    const payTo = PrivateKey.fromRandom().toPublicKey()
    const { beef, txid } = makePaymentTx(payTo, 1234)
    const tx = Transaction.fromAtomicBEEF(beef)
    expect(tx.id('hex')).toBe(txid)
    expect(tx.outputs[0].satoshis).toBe(1234)
    expect(tx.outputs[0].lockingScript.toHex()).toBe(new P2PKH().lock(payTo.toHash()).toHex())
  })
})

describe('payment wire codec', () => {
  it('encode then decode preserves the token', async () => {
    const payer = await makeWallet()
    const { token, txid } = await makeToken(payer, IDENTITY_KEY, 5000)
    const wire = encodePayment('pay-1', token, 'thanks')

    expect(wire.t).toBe('payment')
    expect(typeof wire.token.transaction).toBe('string')

    const parsed = parseWireMessage(overTheWire(wire))
    expect(parsed.t).toBe('payment')
    const decoded = decodePayment(parsed as PaymentWire)
    expect(decoded).toEqual({ id: 'pay-1', token, txid, note: 'thanks' })
    expect(decoded.token.transaction).toEqual(token.transaction)
  })

  it('omits the note when none is given', async () => {
    const payer = await makeWallet()
    const { token } = await makeToken(payer, IDENTITY_KEY, 5000)
    const wire = encodePayment('pay-1', token)
    expect('note' in wire).toBe(false)
    expect('note' in decodePayment(wire)).toBe(false)
  })

  it('outputIndex defaults to 0', async () => {
    const payer = await makeWallet()
    const { token } = await makeToken(payer, IDENTITY_KEY, 5000)
    const { outputIndex: _omit, ...withoutIndex } = token
    const wire = encodePayment('pay-1', withoutIndex)
    expect(wire.token.outputIndex).toBe(0)
    expect(decodePayment(wire).token.outputIndex).toBe(0)

    const { outputIndex: _gone, ...wireToken } = wire.token
    const noIndex = { ...wire, token: wireToken } as unknown as PaymentWire
    expect(decodePayment(noIndex).token.outputIndex).toBe(0)
    expect((parseWireMessage(noIndex) as PaymentWire).token.outputIndex).toBe(0)
  })

  describe('decodePayment rejects with invalid_payment', () => {
    let wire: PaymentWire
    beforeAll(async () => {
      const payer = await makeWallet()
      wire = encodePayment('pay-1', (await makeToken(payer, IDENTITY_KEY, 5000)).token)
    })

    it('baseline: the unmodified wire payment decodes', () => {
      expect(codeOf(() => decodePayment(wire))).toBe('none')
    })

    it.each([
      ['zero', 0],
      ['negative', -1],
      ['fractional', 1.5],
      ['above 21e14', 2.1e15 + 1],
      ['unsafe', 2 ** 53],
      ['NaN', Number.NaN],
      ['a string', '5000']
    ])('amount %s', (_name, amount) => {
      expect(codeOf(() => decodePayment(withTokenField(wire, 'amount', amount)))).toBe(
        'invalid_payment'
      )
    })

    it('accepts the largest valid amount', () => {
      expect(codeOf(() => decodePayment(withTokenField(wire, 'amount', 2.1e15)))).toBe('none')
    })

    it.each([
      ['not base64', 'not base64!'],
      ['unpadded base64', 'AAA'],
      ['base64 with whitespace', 'AAAA AAAA'],
      ['empty', ''],
      ['base64 that is not Atomic BEEF', 'AAAAAAAA'],
      ['a byte array', [1, 2, 3]]
    ])('transaction %s', (_name, transaction) => {
      expect(codeOf(() => decodePayment(withTokenField(wire, 'transaction', transaction)))).toBe(
        'invalid_payment'
      )
    })

    it('transaction one byte over DEFAULTS.maxMessageBytes, before parsing it', () => {
      const chars = 4 * Math.ceil((DEFAULTS.maxMessageBytes + 1) / 3)
      const big = 'A'.repeat(chars) // decodes to maxMessageBytes + 1 zero bytes
      const parse = jest.spyOn(Transaction, 'fromAtomicBEEF')
      try {
        expect(codeOf(() => decodePayment(withTokenField(wire, 'transaction', big)))).toBe(
          'invalid_payment'
        )
        expect(parse).not.toHaveBeenCalled()
      } finally {
        parse.mockRestore()
      }
    })

    it.each(['derivationPrefix', 'derivationSuffix'])('%s too long, empty or not base64', field => {
      for (const value of [
        'A'.repeat(401),
        toBase64(randomBytes(303)), // 404 chars of valid base64
        '',
        'not base64!',
        42
      ]) {
        expect(codeOf(() => decodePayment(withDerivation(wire, field, value)))).toBe(
          'invalid_payment'
        )
      }
      const longest = toBase64(randomBytes(300))
      expect(longest).toHaveLength(400)
      expect(codeOf(() => decodePayment(withDerivation(wire, field, longest)))).toBe('none')
    })

    it.each([
      ['negative', -1],
      ['fractional', 0.5],
      ['above uint32', 2 ** 32],
      ['a string', '0']
    ])('outputIndex %s', (_name, outputIndex) => {
      expect(codeOf(() => decodePayment(withTokenField(wire, 'outputIndex', outputIndex)))).toBe(
        'invalid_payment'
      )
    })

    it('accepts the largest uint32 outputIndex', () => {
      expect(codeOf(() => decodePayment(withTokenField(wire, 'outputIndex', 2 ** 32 - 1)))).toBe(
        'none'
      )
    })

    it('note over 500 chars or not a string', () => {
      expect(codeOf(() => decodePayment({ ...wire, note: 'n'.repeat(500) }))).toBe('none')
      expect(codeOf(() => decodePayment({ ...wire, note: 'n'.repeat(501) }))).toBe(
        'invalid_payment'
      )
      const numeric = { ...wire, note: 7 } as unknown as PaymentWire
      expect(codeOf(() => decodePayment(numeric))).toBe('invalid_payment')
    })

    it.each([
      ['empty', ''],
      ['65 chars', 'a'.repeat(65)],
      ['with a space', 'pay 1'],
      ['non-ASCII', 'paý']
    ])('id %s', (_name, id) => {
      expect(codeOf(() => decodePayment({ ...wire, id }))).toBe('invalid_payment')
    })

    it('a token that is not an object', () => {
      for (const token of [null, 'x', [wire.token]]) {
        const bad = { ...wire, token } as unknown as PaymentWire
        expect(codeOf(() => decodePayment(bad))).toBe('invalid_payment')
      }
    })
  })
})

describe('parseWireMessage', () => {
  it('rejects an unknown type with protocol', () => {
    expect(codeOf(() => parseWireMessage({ t: 'nope' }))).toBe('protocol')
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'bye'],
    ['a number', 1],
    ['an array', [{ t: 'bye' }]],
    ['no type', {}],
    ['a numeric type', { t: 5 }],
    ['an object with a prototype', Object.create({ t: 'bye' })],
    [
      'a class instance',
      new (class Bye {
        t = 'bye'
      })()
    ]
  ])('rejects %s with protocol', (_name, value) => {
    expect(codeOf(() => parseWireMessage(value))).toBe('protocol')
  })

  it('rejects an accessor property with protocol', () => {
    const value = {}
    Object.defineProperty(value, 't', { enumerable: true, get: () => 'bye' })
    expect(codeOf(() => parseWireMessage(value))).toBe('protocol')
  })

  const nonce = toBase64(randomBytes(32))
  const request: PaymentRequestMessage = {
    requestId: 'req-1',
    senderIdentityKey: IDENTITY_KEY,
    amount: 1000,
    description: 'Coffee',
    expiresAt: 1_800_000_000_000,
    requestProof: PROOF
  }
  const valid: Array<[string, WireMessage]> = [
    ['hello', { t: 'hello', v: 1, identityKey: IDENTITY_KEY, nonce }],
    ['auth', { t: 'auth', signature: 'ab'.repeat(71) }],
    [
      'payment',
      {
        t: 'payment',
        id: 'pay_1-A',
        token: {
          customInstructions: { derivationPrefix: 'AAAA', derivationSuffix: 'BBBB' },
          transaction: 'AAAA',
          amount: 5000,
          outputIndex: 0
        },
        note: 'thanks'
      }
    ],
    ['payment.ack accepted', { t: 'payment.ack', id: 'pay-1', status: 'accepted', txid: TXID }],
    ['payment.ack received', { t: 'payment.ack', id: 'pay-1', status: 'received' }],
    [
      'payment.ack rejected',
      { t: 'payment.ack', id: 'pay-1', status: 'rejected', reason: 'bad output' }
    ],
    ['request', { t: 'request', request }],
    [
      'request cancellation',
      {
        t: 'request',
        request: {
          requestId: 'req-1',
          senderIdentityKey: IDENTITY_KEY,
          requestProof: PROOF,
          cancelled: true
        }
      }
    ],
    [
      'request.response paid',
      {
        t: 'request.response',
        response: { requestId: 'req-1', status: 'paid', amountPaid: 1000, note: 'done' }
      }
    ],
    [
      'request.response declined',
      { t: 'request.response', response: { requestId: 'r', status: 'declined' } }
    ],
    ['error', { t: 'error', code: 'protocol', message: 'bad frame' }],
    ['error without message', { t: 'error', code: 'busy' }],
    ['bye', { t: 'bye' }],
    ['ready', { t: 'ready' }]
  ]

  it.each(valid)('accepts %s as a fresh copy', (_name, message) => {
    const input = JSON.parse(JSON.stringify(message)) as Record<string, unknown>
    const out = parseWireMessage(input)
    expect(out).toEqual(message)
    expect(out).not.toBe(input)
  })

  it.each(valid)('strips unknown fields from %s', (_name, message) => {
    const input = { ...(JSON.parse(JSON.stringify(message)) as object), extra: 1 }
    const out = parseWireMessage(input)
    expect(out).toEqual(message)
    expect('extra' in out).toBe(false)
  })

  it('ignores a __proto__ key from JSON without touching any prototype', () => {
    const out = parseWireMessage(JSON.parse('{"t":"bye","__proto__":{"polluted":true}}'))
    expect(out).toEqual({ t: 'bye' })
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect((out as unknown as Record<string, unknown>).polluted).toBeUndefined()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('strips unknown nested fields', () => {
    const payment = valid[2][1] as PaymentWire
    const nested = JSON.parse(
      JSON.stringify({
        ...payment,
        token: {
          ...payment.token,
          sender: IDENTITY_KEY,
          customInstructions: { ...payment.token.customInstructions, protocolID: [2, 'x'] }
        }
      })
    )
    expect(parseWireMessage(nested)).toEqual(payment)

    const req = parseWireMessage({ t: 'request', request: { ...request, extra: true } })
    expect(req).toEqual({ t: 'request', request })

    const res = parseWireMessage({
      t: 'request.response',
      response: { requestId: 'r', status: 'declined', messageId: 'm', sender: IDENTITY_KEY }
    })
    expect(res).toEqual({ t: 'request.response', response: { requestId: 'r', status: 'declined' } })
  })

  it('treats null optional fields as absent', () => {
    expect(parseWireMessage({ t: 'error', code: 'x', message: null })).toEqual({
      t: 'error',
      code: 'x'
    })
    expect(
      parseWireMessage({ t: 'payment.ack', id: 'p', status: 'received', txid: null, reason: null })
    ).toEqual({ t: 'payment.ack', id: 'p', status: 'received' })
  })

  it('leaves payment value checks to decodePayment', () => {
    const payment = valid[2][1] as PaymentWire
    const negative = withTokenField(payment, 'amount', -5)
    expect(codeOf(() => parseWireMessage(negative))).toBe('none')
    expect(codeOf(() => decodePayment(negative))).toBe('invalid_payment')
  })

  const payment = valid[2][1] as PaymentWire
  const invalid: Array<[string, unknown]> = [
    ['hello version 2', { t: 'hello', v: 2, identityKey: IDENTITY_KEY, nonce }],
    ['hello without version', { t: 'hello', identityKey: IDENTITY_KEY, nonce }],
    ['hello uppercase key', { t: 'hello', v: 1, identityKey: IDENTITY_KEY.toUpperCase(), nonce }],
    ['hello off-curve key', { t: 'hello', v: 1, identityKey: '02' + 'ff'.repeat(32), nonce }],
    [
      'hello 31-byte nonce',
      { t: 'hello', v: 1, identityKey: IDENTITY_KEY, nonce: toBase64(randomBytes(31)) }
    ],
    [
      'hello 33-byte nonce',
      { t: 'hello', v: 1, identityKey: IDENTITY_KEY, nonce: toBase64(randomBytes(33)) }
    ],
    [
      'hello base64url nonce',
      { t: 'hello', v: 1, identityKey: IDENTITY_KEY, nonce: '_'.repeat(43) + '=' }
    ],
    ['auth uppercase signature', { t: 'auth', signature: 'AB'.repeat(71) }],
    ['auth signature over 200 chars', { t: 'auth', signature: 'ab'.repeat(101) }],
    ['auth odd-length signature', { t: 'auth', signature: 'abc' }],
    ['auth empty signature', { t: 'auth', signature: '' }],
    ['auth without signature', { t: 'auth' }],
    ['payment id empty', { ...payment, id: '' }],
    ['payment id 65 chars', { ...payment, id: 'a'.repeat(65) }],
    ['payment id with a dot', { ...payment, id: 'pay.1' }],
    ['payment id a number', { ...payment, id: 1 }],
    ['payment without token', { t: 'payment', id: 'p' }],
    ['payment token an array', { ...payment, token: [] }],
    ['payment amount a string', withTokenField(payment, 'amount', '5000')],
    ['payment transaction bytes', withTokenField(payment, 'transaction', [1, 2])],
    ['payment outputIndex a string', withTokenField(payment, 'outputIndex', '0')],
    [
      'payment without customInstructions',
      withTokenField(payment, 'customInstructions', undefined)
    ],
    ['payment numeric prefix', withDerivation(payment, 'derivationPrefix', 1)],
    ['payment note a number', { ...payment, note: 1 }],
    ['ack bad status', { t: 'payment.ack', id: 'p', status: 'ok' }],
    ['ack short txid', { t: 'payment.ack', id: 'p', status: 'accepted', txid: 'ab' }],
    [
      'ack uppercase txid',
      { t: 'payment.ack', id: 'p', status: 'accepted', txid: TXID.toUpperCase() }
    ],
    [
      'ack reason over 500 chars',
      { t: 'payment.ack', id: 'p', status: 'rejected', reason: 'r'.repeat(501) }
    ],
    ['ack bad id', { t: 'payment.ack', id: 'p p', status: 'accepted' }],
    ['request not an object', { t: 'request', request: 'x' }],
    ['request bad proof', { t: 'request', request: { ...request, requestProof: 'ab' } }],
    [
      'request uppercase proof',
      { t: 'request', request: { ...request, requestProof: PROOF.toUpperCase() } }
    ],
    ['request bad sender', { t: 'request', request: { ...request, senderIdentityKey: 'x' } }],
    ['request zero amount', { t: 'request', request: { ...request, amount: 0 } }],
    ['request fractional expiry', { t: 'request', request: { ...request, expiresAt: 1.5 } }],
    ['request cancelled not boolean', { t: 'request', request: { ...request, cancelled: 'yes' } }],
    [
      'response bad status',
      { t: 'request.response', response: { requestId: 'r', status: 'maybe' } }
    ],
    [
      'response paid without amount',
      { t: 'request.response', response: { requestId: 'r', status: 'paid' } }
    ],
    ['error empty code', { t: 'error', code: '' }],
    ['error code over 64 chars', { t: 'error', code: 'c'.repeat(65) }],
    ['error numeric code', { t: 'error', code: 1 }],
    ['error message over 500 chars', { t: 'error', code: 'x', message: 'm'.repeat(501) }]
  ]

  it.each(invalid)('rejects %s with protocol', (_name, value) => {
    expect(codeOf(() => parseWireMessage(value))).toBe('protocol')
  })
})

describe('verifyDirectPayment', () => {
  it('passes for an output paying the derived key', async () => {
    const payer = await makeWallet()
    const payee = await makeWallet()
    const { token, txid } = await makeToken(payer, payee.identityKey, 5000)
    const p: IncomingPayment = { messageId: 'pay-1', sender: payer.identityKey, token }
    await expect(verifyDirectPayment(payee.wallet, p)).resolves.toEqual({ txid, satoshis: 5000 })
  })

  it('derives the key with the payment protocol, the sender and forSelf', async () => {
    const payer = await makeWallet()
    const payee = await makeWallet()
    const { token } = await makeToken(payer, payee.identityKey, 5000)
    const getPublicKey = jest.spyOn(payee.wallet, 'getPublicKey')
    await verifyDirectPayment(
      payee.wallet,
      { messageId: 'pay-1', sender: payer.identityKey, token },
      { originator: 'wallet.example' }
    )
    const { derivationPrefix, derivationSuffix } = token.customInstructions
    expect(getPublicKey).toHaveBeenCalledWith(
      {
        protocolID: PAYMENT_PROTOCOL_ID,
        keyID: `${derivationPrefix} ${derivationSuffix}`,
        counterparty: payer.identityKey,
        forSelf: true
      },
      'wallet.example'
    )
  })

  it('fails with invalid_payment when the sender is a third key', async () => {
    const payer = await makeWallet()
    const payee = await makeWallet()
    const third = await makeWallet()
    const { token } = await makeToken(payer, payee.identityKey, 5000)
    const p: IncomingPayment = { messageId: 'pay-1', sender: third.identityKey, token }
    expect(await asyncCodeOf(() => verifyDirectPayment(payee.wallet, p))).toBe('invalid_payment')
  })

  it('fails with invalid_payment when the amount differs from the output', async () => {
    const payer = await makeWallet()
    const payee = await makeWallet()
    const { token } = await makeToken(payer, payee.identityKey, 5000)
    for (const amount of [4999, 5001]) {
      const p: IncomingPayment = {
        messageId: 'pay-1',
        sender: payer.identityKey,
        token: { ...token, amount }
      }
      expect(await asyncCodeOf(() => verifyDirectPayment(payee.wallet, p))).toBe('invalid_payment')
    }
  })

  it('fails with invalid_payment for a missing output, other derivation or bad token', async () => {
    const payer = await makeWallet()
    const payee = await makeWallet()
    const { token } = await makeToken(payer, payee.identityKey, 5000)
    const variants: Array<Record<string, unknown>> = [
      { token: { ...token, outputIndex: 1 } },
      {
        token: {
          ...token,
          customInstructions: { ...token.customInstructions, derivationSuffix: 'AAAA' }
        }
      },
      { token: { ...token, transaction: [1, 2, 3] } },
      { token: { ...token, transaction: [] } },
      { token: { ...token, amount: -1 } },
      { token: null },
      { sender: 'not-a-key' },
      { sender: payer.identityKey.toUpperCase() }
    ]
    for (const v of variants) {
      const p = { messageId: 'pay-1', sender: payer.identityKey, token, ...v } as IncomingPayment
      expect(await asyncCodeOf(() => verifyDirectPayment(payee.wallet, p))).toBe('invalid_payment')
    }
  })

  it('uses the top-level outputIndex when the token has none', async () => {
    const payer = await makeWallet()
    const payee = await makeWallet()
    const { token, txid } = await makeToken(payer, payee.identityKey, 5000)
    const { outputIndex: _omit, ...noIndex } = token
    await expect(
      verifyDirectPayment(payee.wallet, {
        messageId: 'pay-1',
        sender: payer.identityKey,
        token: noIndex,
        outputIndex: 0
      })
    ).resolves.toEqual({ txid, satoshis: 5000 })
    expect(
      await asyncCodeOf(() =>
        verifyDirectPayment(payee.wallet, {
          messageId: 'pay-1',
          sender: payer.identityKey,
          token: noIndex,
          outputIndex: 1
        })
      )
    ).toBe('invalid_payment')
  })
})

describe('acceptDirectPayment', () => {
  async function setup(): Promise<{
    payer: TestWallet
    payee: TestWallet
    token: PaymentToken
    txid: string
    p: IncomingPayment
  }> {
    const payer = await makeWallet()
    const payee = await makeWallet()
    const { token, txid } = await makeToken(payer, payee.identityKey, 5000)
    const p: IncomingPayment = { messageId: 'pay-1', sender: payer.identityKey, token }
    return { payer, payee, token, txid, p }
  }

  it('calls internalizeAction once with the wallet payment args', async () => {
    const { payer, payee, token, txid, p } = await setup()
    const result = await acceptDirectPayment(payee.wallet, p, { originator: 'wallet.example' })
    expect(result).toEqual({ txid, status: 'accepted' })
    expect(payee.internalizeAction).toHaveBeenCalledTimes(1)
    expect(payee.internalizeAction).toHaveBeenCalledWith(
      {
        tx: token.transaction,
        outputs: [
          {
            outputIndex: 0,
            protocol: 'wallet payment',
            paymentRemittance: {
              senderIdentityKey: payer.identityKey,
              derivationPrefix: token.customInstructions.derivationPrefix,
              derivationSuffix: token.customInstructions.derivationSuffix
            }
          }
        ],
        labels: ['peerpay', 'direct', 'inbound'],
        description: 'Received direct BSV'
      },
      'wallet.example'
    )
  })

  it('passes custom labels and description through', async () => {
    const { payee, p } = await setup()
    await acceptDirectPayment(payee.wallet, p, { labels: ['x'], description: 'Tip' })
    const [args, originator] = payee.internalizeAction.mock.calls[0]
    expect(args.labels).toEqual(['x'])
    expect(args.description).toBe('Tip')
    expect(originator).toBeUndefined()
  })

  it('acceptDirectPayment returns duplicate for a seen key', async () => {
    const { payee, token, txid, p } = await setup()
    const seen = memorySeen()
    await expect(acceptDirectPayment(payee.wallet, p, { seen })).resolves.toEqual({
      txid,
      status: 'accepted'
    })
    const { derivationPrefix, derivationSuffix } = token.customInstructions
    expect([...seen.keys]).toEqual([paymentKey(txid, 0, derivationPrefix, derivationSuffix)])

    await expect(acceptDirectPayment(payee.wallet, p, { seen })).resolves.toEqual({
      txid,
      status: 'duplicate'
    })
    expect(payee.internalizeAction).toHaveBeenCalledTimes(1)
  })

  it('works with an asynchronous seen store', async () => {
    const { payee, txid, p } = await setup()
    const keys = new Set<string>()
    const seen: SeenStore = {
      has: async key => keys.has(key),
      add: async key => {
        keys.add(key)
      }
    }
    expect((await acceptDirectPayment(payee.wallet, p, { seen })).status).toBe('accepted')
    expect(await acceptDirectPayment(payee.wallet, p, { seen })).toEqual({
      txid,
      status: 'duplicate'
    })
    expect(payee.internalizeAction).toHaveBeenCalledTimes(1)
  })

  it('internalizes every time without a seen store', async () => {
    const { payee, p } = await setup()
    await acceptDirectPayment(payee.wallet, p)
    await acceptDirectPayment(payee.wallet, p)
    expect(payee.internalizeAction).toHaveBeenCalledTimes(2)
  })

  it('does not record a payment the wallet did not accept', async () => {
    const { payee, p } = await setup()
    const seen = memorySeen()
    payee.internalizeAction.mockResolvedValueOnce({ accepted: false } as unknown as {
      accepted: true
    })
    const code = await asyncCodeOf(() => acceptDirectPayment(payee.wallet, p, { seen }))
    expect(code).toMatch(/^other:.*did not accept/)
    expect(seen.keys.size).toBe(0)

    await expect(acceptDirectPayment(payee.wallet, p, { seen })).resolves.toMatchObject({
      status: 'accepted'
    })
    expect(payee.internalizeAction).toHaveBeenCalledTimes(2)
  })

  it('propagates a wallet error unchanged and records nothing', async () => {
    const { payee, p } = await setup()
    const seen = memorySeen()
    const failure = new Error('storage offline')
    payee.internalizeAction.mockRejectedValueOnce(failure)
    await expect(acceptDirectPayment(payee.wallet, p, { seen })).rejects.toBe(failure)
    expect(seen.keys.size).toBe(0)
  })

  it('rejects an invalid payment without internalizing or recording it', async () => {
    const { payee, p } = await setup()
    const third = await makeWallet()
    const seen = memorySeen()
    const code = await asyncCodeOf(() =>
      acceptDirectPayment(payee.wallet, { ...p, sender: third.identityKey }, { seen })
    )
    expect(code).toBe('invalid_payment')
    expect(payee.internalizeAction).not.toHaveBeenCalled()
    expect(seen.keys.size).toBe(0)
  })

  it('returns accepted when recording a payment fails after the wallet took it (M18)', async () => {
    const { payee, txid, p } = await setup()
    const failure = new Error('quota exceeded')
    const reported: unknown[] = []
    const failing = (add: SeenStore['add']): SeenStore => ({ has: () => false, add })
    for (const seen of [
      failing(() => {
        throw failure
      }),
      failing(async () => {
        throw failure
      })
    ]) {
      await expect(
        acceptDirectPayment(payee.wallet, p, { seen, onSeenError: e => reported.push(e) })
      ).resolves.toEqual({ txid, status: 'accepted' })
    }
    expect(reported).toEqual([failure, failure])
    // without a hook, or with one that throws, it is accepted all the same
    await expect(
      acceptDirectPayment(payee.wallet, p, {
        seen: failing(() => {
          throw failure
        })
      })
    ).resolves.toEqual({ txid, status: 'accepted' })
    await expect(
      acceptDirectPayment(payee.wallet, p, {
        seen: failing(() => {
          throw failure
        }),
        onSeenError: () => {
          throw new Error('hook bug')
        }
      })
    ).resolves.toEqual({ txid, status: 'accepted' })
    expect(payee.internalizeAction).toHaveBeenCalledTimes(4)
  })

  it('paymentKey distinguishes every component', () => {
    const base = paymentKey(TXID, 0, 'AAAA', 'BBBB')
    expect(paymentKey(TXID, 0, 'AAAA', 'BBBB')).toBe(base)
    expect(
      new Set([
        base,
        paymentKey('cd'.repeat(32), 0, 'AAAA', 'BBBB'),
        paymentKey(TXID, 1, 'AAAA', 'BBBB'),
        paymentKey(TXID, 0, 'AAAB', 'BBBB'),
        paymentKey(TXID, 0, 'AAAA', 'BBBC')
      ]).size
    ).toBe(5)
  })
})

describe('payment tokens with a Uint8Array transaction (R9)', () => {
  it('encodePayment writes the same wire message for number[] and Uint8Array', async () => {
    const payer = await makeWallet()
    const { token } = await makeToken(payer, IDENTITY_KEY, 5000)
    const bytes: PaymentTokenInput = { ...token, transaction: Uint8Array.from(token.transaction) }
    expect(encodePayment('pay-1', bytes, 'hi')).toEqual(encodePayment('pay-1', token, 'hi'))
    // what comes out of the wire is always a number array
    expect(Array.isArray(decodePayment(encodePayment('pay-1', bytes)).token.transaction)).toBe(true)
  })

  it('verifyDirectPayment and acceptDirectPayment take a Uint8Array transaction', async () => {
    const payer = await makeWallet()
    const payee = await makeWallet()
    const { token, txid } = await makeToken(payer, payee.identityKey, 5000)
    const p = {
      messageId: 'pay-1',
      sender: payer.identityKey,
      token: { ...token, transaction: Uint8Array.from(token.transaction) }
    }
    await expect(verifyDirectPayment(payee.wallet, p)).resolves.toEqual({ txid, satoshis: 5000 })
    await expect(acceptDirectPayment(payee.wallet, p)).resolves.toEqual({
      txid,
      status: 'accepted'
    })
    const [args] = payee.internalizeAction.mock.calls[0]
    expect(Array.from(args.tx)).toEqual(token.transaction)
  })

  it('still rejects a transaction that is not bytes', async () => {
    const payer = await makeWallet()
    const payee = await makeWallet()
    const { token } = await makeToken(payer, payee.identityKey, 5000)
    for (const transaction of [
      toBase64(Uint8Array.from(token.transaction)),
      new Uint16Array(token.transaction),
      token.transaction.map(b => (b === 0 ? 256 : b)),
      [...token.transaction.slice(0, -1), 1.5]
    ]) {
      const p = { messageId: 'pay-1', sender: payer.identityKey, token: { ...token, transaction } }
      expect(
        await asyncCodeOf(() => verifyDirectPayment(payee.wallet, p as unknown as IncomingPayment))
      ).toBe('invalid_payment')
    }
  })
})

describe('validatePaymentToken (M20)', () => {
  it('passes a token the payee can decode, as number[] or Uint8Array, with or without a note', async () => {
    const payer = await makeWallet()
    const { token } = await makeToken(payer, IDENTITY_KEY, 5000)
    expect(() => validatePaymentToken(token)).not.toThrow()
    expect(() => validatePaymentToken(token, 'x'.repeat(500))).not.toThrow()
    const { outputIndex: _omit, ...noIndex } = token
    expect(() =>
      validatePaymentToken({ ...noIndex, transaction: Uint8Array.from(token.transaction) })
    ).not.toThrow()
  })

  it('throws invalid_payment for everything the payee would reject without its key', async () => {
    const payer = await makeWallet()
    const { token } = await makeToken(payer, IDENTITY_KEY, 5000)
    const bad: Array<[string, unknown, string?]> = [
      ['no output at outputIndex', { ...token, outputIndex: 1 }],
      ['amount differs from the output', { ...token, amount: 4999 }],
      ['amount out of range', { ...token, amount: 0 }],
      ['outputIndex not a uint32', { ...token, outputIndex: -1 }],
      [
        'derivation not base64',
        { ...token, customInstructions: { ...token.customInstructions, derivationPrefix: 'a b' } }
      ],
      ['transaction not Atomic BEEF', { ...token, transaction: [1, 2, 3] }],
      ['empty transaction', { ...token, transaction: [] }],
      [
        'transaction with a value that is not a byte',
        { ...token, transaction: [...token.transaction, 256] }
      ],
      ['transaction as text', { ...token, transaction: 'AAAA' }],
      ['note over 500 characters', token, 'x'.repeat(501)],
      ['not an object', null]
    ]
    for (const [why, t, note] of bad) {
      expect([why, codeOf(() => validatePaymentToken(t as PaymentTokenInput, note))]).toEqual([
        why,
        'invalid_payment'
      ])
    }
  })
})

describe('MAX_DIRECT_TRANSACTION_BYTES (M19)', () => {
  it('fits a payment message within the default inbound cap with every other field at its largest', () => {
    expect(MAX_DIRECT_TRANSACTION_BYTES).toBe(12579840)
    const wire = encodePayment(
      'i'.repeat(64),
      {
        customInstructions: {
          derivationPrefix: 'P'.repeat(400),
          derivationSuffix: 'S'.repeat(400)
        },
        transaction: new Uint8Array(MAX_DIRECT_TRANSACTION_BYTES),
        amount: 2.1e15,
        outputIndex: 0xffffffff
      },
      // each of these characters becomes the six bytes \u0001 in JSON
      '\u0001'.repeat(500)
    )
    const bytes = utf8Encode(JSON.stringify(wire)).length
    expect(bytes).toBeLessThanOrEqual(DEFAULTS.inboundMaxMessageBytes)
    expect(bytes).toBeGreaterThan(DEFAULTS.inboundMaxMessageBytes - 4096)
  })
})

describe('payment request proofs', () => {
  it('a proof created by A verifies at B and fails for a different recipient', async () => {
    const a = await makeWallet()
    const b = await makeWallet()
    const c = await makeWallet()
    const requestProof = await createPaymentRequestProof(a.wallet, 'req-1', b.identityKey)
    expect(requestProof).toMatch(/^[0-9a-f]{64}$/)
    const req: PaymentRequestMessage = {
      requestId: 'req-1',
      senderIdentityKey: a.identityKey,
      amount: 1000,
      description: 'Coffee',
      expiresAt: Date.now() + 60_000,
      requestProof
    }

    await expect(
      verifyPaymentRequestProof(b.wallet, req, b.identityKey, a.identityKey)
    ).resolves.toBe(true)
    await expect(
      verifyPaymentRequestProof(c.wallet, req, c.identityKey, a.identityKey)
    ).resolves.toBe(false)
    await expect(
      verifyPaymentRequestProof(b.wallet, req, c.identityKey, a.identityKey)
    ).resolves.toBe(false)
    await expect(
      verifyPaymentRequestProof(b.wallet, req, b.identityKey, c.identityKey)
    ).resolves.toBe(false)
    await expect(
      verifyPaymentRequestProof(
        b.wallet,
        { ...req, requestId: 'req-2' },
        b.identityKey,
        a.identityKey
      )
    ).resolves.toBe(false)
  })

  it('a cancellation carries the same proof', async () => {
    const a = await makeWallet()
    const b = await makeWallet()
    const requestProof = await createPaymentRequestProof(a.wallet, 'req-1', b.identityKey)
    const cancel: PaymentRequestMessage = {
      requestId: 'req-1',
      senderIdentityKey: a.identityKey,
      requestProof,
      cancelled: true
    }
    await expect(
      verifyPaymentRequestProof(b.wallet, cancel, b.identityKey, a.identityKey)
    ).resolves.toBe(true)
  })

  it('matches the message-box-client HMAC over requestId + recipient', async () => {
    const a = await makeWallet()
    const b = await makeWallet()
    const proof = await createPaymentRequestProof(a.wallet, 'req-1', b.identityKey, 'app.example')
    const { hmac } = await a.wallet.createHmac({
      data: Array.from(new TextEncoder().encode('req-1' + b.identityKey)),
      protocolID: [2, 'payment request auth'],
      keyID: 'req-1',
      counterparty: b.identityKey
    })
    expect(proof).toBe(toHex(Uint8Array.from(hmac)))
  })

  it('returns false for a malformed proof', async () => {
    const a = await makeWallet()
    const b = await makeWallet()
    const req = {
      requestId: 'req-1',
      senderIdentityKey: a.identityKey,
      requestProof: 'xyz',
      cancelled: true
    } as PaymentRequestMessage
    await expect(
      verifyPaymentRequestProof(b.wallet, req, b.identityKey, a.identityKey)
    ).resolves.toBe(false)
  })

  it('refuses to create a proof for a recipient that is not an identity key', async () => {
    const a = await makeWallet()
    await expect(createPaymentRequestProof(a.wallet, 'req-1', 'anyone')).rejects.toThrow(TypeError)
  })
})

describe('normalizePaymentRequest', () => {
  const sender = IDENTITY_KEY
  const request = {
    requestId: 'req-1',
    senderIdentityKey: sender,
    amount: 1000,
    description: 'Coffee',
    expiresAt: 1_800_000_000_000,
    requestProof: PROOF
  }

  it('returns a fresh copy of a valid request without unknown fields', () => {
    const input = { ...request, extra: 1, cancelled: false }
    const out = normalizePaymentRequest(input, sender)
    expect(out).toEqual(request)
    expect(out).not.toBe(input)
  })

  it('returns only the cancellation fields for a cancellation', () => {
    expect(normalizePaymentRequest({ ...request, cancelled: true }, sender)).toEqual({
      requestId: 'req-1',
      senderIdentityKey: sender,
      requestProof: PROOF,
      cancelled: true
    })
  })

  it('requires senderIdentityKey to be the sender', () => {
    const other = PrivateKey.fromRandom().toPublicKey().toString()
    expect(codeOf(() => normalizePaymentRequest(request, other))).toBe('protocol')
    expect(codeOf(() => normalizePaymentRequest({ ...request, cancelled: true }, other))).toBe(
      'protocol'
    )
  })

  it('bounds the description in UTF-8 bytes', () => {
    const at = { ...request, description: 'é'.repeat(1000) } // 2000 bytes
    const over = { ...request, description: 'é'.repeat(1000) + 'x' } // 2001 bytes
    expect(codeOf(() => normalizePaymentRequest(at, sender))).toBe('none')
    expect(codeOf(() => normalizePaymentRequest(over, sender))).toBe('protocol')
  })

  it.each([
    ['empty description', { description: '' }],
    ['newline in description', { description: 'a\nb' }],
    ['C1 control in description', { description: 'a\u0085b' }],
    ['DEL in requestId', { requestId: 'a\u007fb' }],
    ['empty requestId', { requestId: '' }],
    ['requestId over 1024 bytes', { requestId: 'r'.repeat(1025) }],
    ['proof not 64 hex', { requestProof: 'ab'.repeat(31) }],
    ['unsafe amount', { amount: 2 ** 53 }],
    ['negative amount', { amount: -1 }],
    ['string amount', { amount: '1000' }],
    ['zero expiry', { expiresAt: 0 }],
    ['fractional expiry', { expiresAt: 1.5 }],
    ['cancelled not boolean', { cancelled: 1 }]
  ])('rejects %s with protocol', (_name, change) => {
    expect(codeOf(() => normalizePaymentRequest({ ...request, ...change }, sender))).toBe(
      'protocol'
    )
  })

  it('rejects non-objects with protocol', () => {
    for (const v of [null, 'x', [request]]) {
      expect(codeOf(() => normalizePaymentRequest(v, sender))).toBe('protocol')
    }
  })
})

describe('normalizePaymentRequestResponse', () => {
  it('accepts paid and declined responses and drops envelope fields', () => {
    expect(
      normalizePaymentRequestResponse({
        requestId: 'req-1',
        status: 'paid',
        amountPaid: 1000,
        note: 'done',
        messageId: 'm',
        sender: IDENTITY_KEY
      })
    ).toEqual({ requestId: 'req-1', status: 'paid', amountPaid: 1000, note: 'done' })
    expect(
      normalizePaymentRequestResponse({ requestId: 'req-1', status: 'declined', amountPaid: 5 })
    ).toEqual({ requestId: 'req-1', status: 'declined' })
  })

  it.each([
    ['unknown status', { requestId: 'r', status: 'maybe' }],
    ['paid without amount', { requestId: 'r', status: 'paid' }],
    ['paid with zero amount', { requestId: 'r', status: 'paid', amountPaid: 0 }],
    ['empty requestId', { requestId: '', status: 'declined' }],
    ['note over 2000 bytes', { requestId: 'r', status: 'declined', note: 'n'.repeat(2001) }],
    ['control char in note', { requestId: 'r', status: 'declined', note: 'a\tb' }],
    ['not an object', 'declined']
  ])('rejects %s with protocol', (_name, value) => {
    expect(codeOf(() => normalizePaymentRequestResponse(value))).toBe('protocol')
  })
})
