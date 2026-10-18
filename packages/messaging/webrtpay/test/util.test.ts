import { describe, expect, it, jest } from '@jest/globals'
import { PrivateKey } from '@bsv/sdk'
import type { WalletInterface } from '@bsv/sdk'
import * as barrel from '../src/index.js'
import {
  CHANNEL_LABEL,
  CHANNEL_PROTOCOL_ID,
  CODE_PREFIX,
  DEFAULTS,
  PAYMENT_PROTOCOL_ID,
  PAYMENT_REQUEST_PROTOCOL_ID,
  RELAY_PROTOCOL_ID,
  SIGNALING_PROTOCOL_ID,
  SIGNALS_MESSAGEBOX,
  isIdentityKey
} from '../src/types.js'
import type {
  IncomingPayment,
  IncomingPaymentRequest,
  PaymentRequestMessage,
  PaymentRequestResponse,
  PaymentToken,
  WalletLike
} from '../src/types.js'
import {
  concatBytes,
  equalBytes,
  fromBase64,
  fromBase64Url,
  fromHex,
  randomBytes,
  toBase64,
  toBase64Url,
  toHex,
  utf8Decode,
  utf8Encode
} from '../src/util/bytes.js'
import { Emitter } from '../src/util/emitter.js'
import { WebRTPayError } from '../src/util/errors.js'
import type { WebRTPayErrorCode } from '../src/util/errors.js'

/** Deterministic non-trivial byte patterns of every length 0..max. */
function patterns(max: number): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let n = 0; n <= max; n++) {
    out.push(Uint8Array.from({ length: n }, (_, i) => (i * 37 + n * 11 + 5) & 0xff))
  }
  return out
}

describe('bytes: utf8', () => {
  it('round trips ASCII, multibyte, astral and empty strings', () => {
    for (const s of ['', 'hello', 'héllo wörld', '日本語', 'emoji 🙂🚀', '\u0000\u0001']) {
      expect(utf8Decode(utf8Encode(s))).toBe(s)
    }
    expect(utf8Encode('é')).toEqual(Uint8Array.of(0xc3, 0xa9))
  })

  it('preserves a leading byte order mark', () => {
    const s = '﻿abc'
    expect(utf8Decode(utf8Encode(s))).toBe(s)
  })

  it('throws on invalid UTF-8 instead of substituting', () => {
    expect(() => utf8Decode(Uint8Array.of(0xff, 0xfe))).toThrow(WebRTPayError)
    expect(() => utf8Decode(Uint8Array.of(0xc3))).toThrow(WebRTPayError)
    expect(() => utf8Decode(Uint8Array.of(0xed, 0xa0, 0x80))).toThrow(WebRTPayError)
  })
})

describe('bytes: hex', () => {
  it('round trips every length including empty', () => {
    for (const b of patterns(40)) {
      expect(fromHex(toHex(b))).toEqual(b)
    }
    expect(toHex(new Uint8Array(0))).toBe('')
    expect(fromHex('')).toEqual(new Uint8Array(0))
  })

  it('encodes lowercase and covers all byte values', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i)
    expect(toHex(all)).toBe(Buffer.from(all).toString('hex'))
    expect(toHex(Uint8Array.of(0xab, 0x0f))).toBe('ab0f')
    expect(fromHex(toHex(all))).toEqual(all)
  })

  it('decodes upper and mixed case', () => {
    expect(fromHex('ABcd')).toEqual(Uint8Array.of(0xab, 0xcd))
  })

  it('rejects odd length and non-hex characters', () => {
    expect(() => fromHex('abc')).toThrow(WebRTPayError)
    expect(() => fromHex('zz')).toThrow(WebRTPayError)
    expect(() => fromHex('0x')).toThrow(WebRTPayError)
    expect(() => fromHex('ab cd')).toThrow(WebRTPayError)
    expect(() => fromHex('ab\n')).toThrow(WebRTPayError)
  })
})

describe('bytes: base64', () => {
  it('matches RFC 4648 test vectors', () => {
    const vectors: Array<[string, string]> = [
      ['', ''],
      ['f', 'Zg=='],
      ['fo', 'Zm8='],
      ['foo', 'Zm9v'],
      ['foob', 'Zm9vYg=='],
      ['fooba', 'Zm9vYmE='],
      ['foobar', 'Zm9vYmFy']
    ]
    for (const [plain, encoded] of vectors) {
      expect(toBase64(utf8Encode(plain))).toBe(encoded)
      expect(utf8Decode(fromBase64(encoded))).toBe(plain)
    }
  })

  it('round trips every length 0..64 and agrees with Buffer', () => {
    for (const b of patterns(64)) {
      const encoded = toBase64(b)
      expect(encoded).toBe(Buffer.from(b).toString('base64'))
      expect(fromBase64(encoded)).toEqual(b)
    }
  })

  it('handles a large buffer', () => {
    const big = randomBytes(1 << 20)
    expect(fromBase64(toBase64(big))).toEqual(big)
  })

  it('rejects malformed input strictly', () => {
    expect(() => fromBase64('Zg')).toThrow(WebRTPayError) // missing padding
    expect(() => fromBase64('Zg=')).toThrow(WebRTPayError)
    expect(() => fromBase64('Zm9v\n')).toThrow(WebRTPayError)
    expect(() => fromBase64('Zm 9v')).toThrow(WebRTPayError)
    expect(() => fromBase64('Zm9')).toThrow(WebRTPayError) // length % 4 != 0
    expect(() => fromBase64('a-b_')).toThrow(WebRTPayError) // url alphabet
    expect(() => fromBase64('Zg==Zg==')).toThrow(WebRTPayError) // padding mid-string
    expect(() => fromBase64('=Zg=')).toThrow(WebRTPayError)
    expect(() => fromBase64('Zh==')).toThrow(WebRTPayError) // non-zero trailing bits
    expect(() => fromBase64('Zm9=')).toThrow(WebRTPayError) // non-zero trailing bits
    expect(() => fromBase64('Zm9vé')).toThrow(WebRTPayError)
  })
})

describe('bytes: base64url', () => {
  it('round trips every length 0..64 without padding and agrees with Buffer', () => {
    for (const b of patterns(64)) {
      const encoded = toBase64Url(b)
      expect(encoded).toBe(Buffer.from(b).toString('base64url'))
      expect(encoded).not.toContain('=')
      expect(fromBase64Url(encoded)).toEqual(b)
    }
    expect(toBase64Url(new Uint8Array(0))).toBe('')
    expect(fromBase64Url('')).toEqual(new Uint8Array(0))
  })

  it('uses the url-safe alphabet', () => {
    const b = Uint8Array.of(0xfb, 0xff, 0xfe)
    expect(toBase64(b)).toBe('+//+')
    expect(toBase64Url(b)).toBe('-__-')
    expect(fromBase64Url('-__-')).toEqual(b)
  })

  it('rejects the standard alphabet, padding, whitespace and bad lengths', () => {
    expect(() => fromBase64Url('a+b')).toThrow(WebRTPayError)
    expect(() => fromBase64Url('a/b')).toThrow(WebRTPayError)
    expect(() => fromBase64Url('Zg==')).toThrow(WebRTPayError)
    expect(() => fromBase64Url('Zm9v ')).toThrow(WebRTPayError)
    expect(() => fromBase64Url('Zm9v\n')).toThrow(WebRTPayError)
    expect(() => fromBase64Url('Z')).toThrow(WebRTPayError) // length % 4 == 1
    expect(() => fromBase64Url('Zm9vY')).toThrow(WebRTPayError)
    expect(() => fromBase64Url('Zh')).toThrow(WebRTPayError) // non-zero trailing bits
    expect(() => fromBase64Url('Zm9vé')).toThrow(WebRTPayError)
  })
})

describe('bytes: randomBytes / concatBytes / equalBytes', () => {
  it('returns the requested number of bytes, also beyond the 64 KiB getRandomValues limit', () => {
    expect(randomBytes(0)).toEqual(new Uint8Array(0))
    expect(randomBytes(32).length).toBe(32)
    const big = randomBytes(200000)
    expect(big.length).toBe(200000)
    expect(big.some(v => v !== 0)).toBe(true)
    expect(big.subarray(70000, 70064).some(v => v !== 0)).toBe(true)
  })

  it('produces different output on each call', () => {
    expect(equalBytes(randomBytes(32), randomBytes(32))).toBe(false)
  })

  it('rejects invalid lengths', () => {
    for (const n of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => randomBytes(n)).toThrow(RangeError)
    }
  })

  it('concatenates parts in order and copies', () => {
    expect(concatBytes()).toEqual(new Uint8Array(0))
    const a = Uint8Array.of(1, 2)
    const out = concatBytes(a, new Uint8Array(0), Uint8Array.of(3), Uint8Array.of(4, 5))
    expect(out).toEqual(Uint8Array.of(1, 2, 3, 4, 5))
    out[0] = 9
    expect(a[0]).toBe(1)
  })

  it('compares by length and content', () => {
    expect(equalBytes(new Uint8Array(0), new Uint8Array(0))).toBe(true)
    expect(equalBytes(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 3))).toBe(true)
    expect(equalBytes(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 4))).toBe(false)
    expect(equalBytes(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2))).toBe(false)
    expect(equalBytes(Uint8Array.of(0), new Uint8Array(0))).toBe(false)
  })
})

describe('Emitter', () => {
  type Events = { data: number; done: undefined }

  it('delivers events to listeners and unsubscribes', () => {
    const e = new Emitter<Events>()
    const seen: number[] = []
    const off = e.on('data', v => seen.push(v))
    e.emit('data', 1)
    e.emit('data', 2)
    off()
    e.emit('data', 3)
    expect(seen).toEqual([1, 2])
  })

  it('emits with no listeners without throwing', () => {
    const e = new Emitter<Events>()
    expect(() => e.emit('done', undefined)).not.toThrow()
  })

  it('once fires exactly once', () => {
    const e = new Emitter<Events>()
    const fn = jest.fn()
    e.once('data', fn)
    e.emit('data', 1)
    e.emit('data', 2)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(1)
  })

  it('once can be cancelled before it fires', () => {
    const e = new Emitter<Events>()
    const fn = jest.fn()
    const off = e.once('data', fn)
    off()
    e.emit('data', 1)
    expect(fn).not.toHaveBeenCalled()
  })

  it('treats registering the same function twice as two registrations', () => {
    const e = new Emitter<Events>()
    const fn = jest.fn()
    const off1 = e.on('data', fn)
    e.on('data', fn)
    e.emit('data', 1)
    expect(fn).toHaveBeenCalledTimes(2)
    off1()
    e.emit('data', 2)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('a throwing listener does not stop the others and is reported', () => {
    const errors: Array<[unknown, string]> = []
    const e = new Emitter<Events>((err, event) => errors.push([err, String(event)]))
    const boom = new Error('boom')
    const after = jest.fn()
    e.on('data', () => {
      throw boom
    })
    e.on('data', after)
    expect(() => e.emit('data', 7)).not.toThrow()
    expect(after).toHaveBeenCalledWith(7)
    expect(errors).toEqual([[boom, 'data']])
  })

  it('swallows listener errors when no onListenerError is set', () => {
    const e = new Emitter<Events>()
    const after = jest.fn()
    e.on('data', () => {
      throw new Error('boom')
    })
    e.on('data', after)
    expect(() => e.emit('data', 1)).not.toThrow()
    expect(after).toHaveBeenCalledTimes(1)
  })

  it('survives an onListenerError that itself throws', () => {
    const e = new Emitter<Events>(() => {
      throw new Error('reporter broke')
    })
    const after = jest.fn()
    e.on('data', () => {
      throw new Error('boom')
    })
    e.on('data', after)
    expect(() => e.emit('data', 1)).not.toThrow()
    expect(after).toHaveBeenCalledTimes(1)
  })

  it('reports rejected promises from async listeners', async () => {
    const errors: unknown[] = []
    const e = new Emitter<Events>(err => errors.push(err))
    const boom = new Error('async boom')
    e.on('data', async () => {
      throw boom
    })
    e.emit('data', 1)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(errors).toEqual([boom])
  })

  it('reports rejected promises from async once listeners and never leaks them', async () => {
    const errors: unknown[] = []
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const e = new Emitter<Events>(err => errors.push(err))
      const boom = new Error('async once boom')
      e.once('data', async () => {
        throw boom
      })
      e.emit('data', 1)
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(errors).toEqual([boom])
      expect(unhandled).toEqual([])
      // still delivered exactly once
      e.emit('data', 2)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(errors).toEqual([boom])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('emits to a snapshot: unsubscribing or subscribing mid-emit is safe', () => {
    const e = new Emitter<Events>()
    const calls: string[] = []
    const offA = e.on('data', () => {
      calls.push('a')
      offA()
      e.on('data', () => calls.push('late'))
    })
    e.on('data', () => calls.push('b'))
    e.emit('data', 1)
    expect(calls).toEqual(['a', 'b'])
    e.emit('data', 2)
    expect(calls).toEqual(['a', 'b', 'b', 'late'])
  })

  it('clear removes every listener', () => {
    const e = new Emitter<Events>()
    const fn = jest.fn()
    e.on('data', fn)
    e.once('done', fn)
    e.clear()
    e.emit('data', 1)
    e.emit('done', undefined)
    expect(fn).not.toHaveBeenCalled()
  })

  it('keeps events independent', () => {
    const e = new Emitter<Events>()
    const data = jest.fn()
    e.on('data', data)
    e.emit('done', undefined)
    expect(data).not.toHaveBeenCalled()
  })
})

describe('WebRTPayError', () => {
  it('carries a code, defaults the message to the code and is an Error', () => {
    const err = new WebRTPayError('protocol')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(WebRTPayError)
    expect(err.code).toBe('protocol')
    expect(err.message).toBe('protocol')
    expect(err.name).toBe('WebRTPayError')
    expect('cause' in err).toBe(false)
  })

  it('accepts a message and a cause', () => {
    const cause = new Error('inner')
    const err = new WebRTPayError('closed', 'peer went away', { cause })
    expect(err.code).toBe('closed')
    expect(err.message).toBe('peer went away')
    expect(err.cause).toBe(cause)
  })

  it('carries a reason only when one is given', () => {
    const refused = new WebRTPayError('rejected', 'other network', { reason: 'wrong_network' })
    expect(refused.reason).toBe('wrong_network')
    expect('cause' in refused).toBe(false)
    expect('reason' in new WebRTPayError('rejected')).toBe(false)
  })

  it('has a stack trace', () => {
    expect(new WebRTPayError('timeout', 'slow').stack).toContain('slow')
  })

  it('covers the documented error codes', () => {
    const codes: WebRTPayErrorCode[] = [
      'timeout',
      'closed',
      'protocol',
      'auth_failed',
      'peer_unreachable',
      'rejected',
      'invalid_code',
      'invalid_payment',
      'invalid_signal',
      'rate_limited',
      'too_large',
      'unsupported'
    ]
    for (const code of codes) expect(new WebRTPayError(code).code).toBe(code)
  })
})

describe('isIdentityKey', () => {
  it('accepts canonical compressed public keys', () => {
    for (let i = 0; i < 25; i++) {
      expect(isIdentityKey(PrivateKey.fromRandom().toPublicKey().toString())).toBe(true)
    }
    // the BRC-100 "anyone" key (private key = 1)
    expect(isIdentityKey(new PrivateKey(1).toPublicKey().toString())).toBe(true)
  })

  it('rejects uppercase hex', () => {
    const key = PrivateKey.fromRandom().toPublicKey().toString()
    expect(isIdentityKey(key.toUpperCase())).toBe(false)
    expect(isIdentityKey(key.slice(0, 2) + key.slice(2).toUpperCase())).toBe(false)
  })

  it('rejects uncompressed 04... keys', () => {
    const uncompressed = PrivateKey.fromRandom().toPublicKey().encode(false, 'hex') as string
    expect(uncompressed).toMatch(/^04[0-9a-f]{128}$/)
    expect(isIdentityKey(uncompressed)).toBe(false)
  })

  it('rejects wrong lengths and prefixes', () => {
    const key = PrivateKey.fromRandom().toPublicKey().toString()
    expect(isIdentityKey(key + '0')).toBe(false) // 67 chars
    expect(isIdentityKey(key.slice(0, 64) + '0')).toBe(false) // 65 chars
    expect(isIdentityKey('0' + key.slice(0, 64))).toBe(false)
    expect(isIdentityKey('')).toBe(false)
    expect(isIdentityKey('05' + key.slice(2))).toBe(false)
    expect(isIdentityKey('00' + key.slice(2))).toBe(false)
    expect(isIdentityKey(' ' + key)).toBe(false)
    expect(isIdentityKey(key + '\n')).toBe(false)
  })

  it('rejects hex that is not a point on the curve', () => {
    expect(isIdentityKey('02' + '0'.repeat(63) + '5')).toBe(false)
  })

  it('rejects non-strings', () => {
    for (const v of [undefined, null, 2, {}, [], Uint8Array.of(2)]) {
      expect(isIdentityKey(v)).toBe(false)
    }
  })

  it('narrows the type', () => {
    const v: unknown = PrivateKey.fromRandom().toPublicKey().toString()
    if (isIdentityKey(v)) {
      const key: string = v
      expect(key).toHaveLength(66)
    } else {
      throw new Error('expected a valid identity key')
    }
  })
})

describe('constants', () => {
  it('pins the wire protocol identifiers', () => {
    expect(PAYMENT_PROTOCOL_ID).toEqual([2, '3241645161d8'])
    expect(CHANNEL_PROTOCOL_ID).toEqual([2, 'webrtpay channel'])
    expect(SIGNALING_PROTOCOL_ID).toEqual([2, 'webrtpay signaling'])
    expect(RELAY_PROTOCOL_ID).toEqual([2, 'webrtpay relay'])
    expect(PAYMENT_REQUEST_PROTOCOL_ID).toEqual([2, 'payment request auth'])
    expect(CHANNEL_LABEL).toBe('webrtpay/1')
    expect(SIGNALS_MESSAGEBOX).toBe('webrtpay_signals')
    expect(CODE_PREFIX).toBe('webrtpay1:')
  })

  it('pins the numeric defaults', () => {
    expect({ ...DEFAULTS }).toEqual({
      chunkBytes: 16384,
      maxMessageBytes: 32 * 1024 * 1024,
      inboundMaxMessageBytes: 16 * 1024 * 1024,
      gatherTimeoutMs: 5000,
      handshakeTimeoutMs: 15000,
      connectTimeoutMs: 30000,
      ackTimeoutMs: 45000,
      signalMaxSkewMs: 120000,
      payeePollMs: 2500,
      payerPollMs: 1000
    })
  })

  it('freezes the defaults', () => {
    expect(Object.isFrozen(DEFAULTS)).toBe(true)
  })

  it('keeps protocol ids usable as wallet protocol tuples', () => {
    // compile-time: WalletProtocol is [SecurityLevel, string]
    const tuples: Array<[0 | 1 | 2, string]> = [
      PAYMENT_PROTOCOL_ID,
      CHANNEL_PROTOCOL_ID,
      SIGNALING_PROTOCOL_ID,
      RELAY_PROTOCOL_ID,
      PAYMENT_REQUEST_PROTOCOL_ID
    ]
    expect(tuples).toHaveLength(5)
  })
})

describe('types', () => {
  it('WalletLike is satisfied by a full WalletInterface', () => {
    // compile-time assertion only; the cast never runs a wallet method
    const full = {} as WalletInterface
    const like: WalletLike = full
    expect(like).toBe(full)
  })

  it('models payment tokens and incoming payments', () => {
    const token: PaymentToken = {
      customInstructions: { derivationPrefix: 'cHJlZml4', derivationSuffix: 'c3VmZml4' },
      transaction: [1, 2, 3],
      amount: 1000
    }
    const withIndex: PaymentToken = { ...token, outputIndex: 1 }
    const incoming: IncomingPayment = {
      messageId: 'm1',
      sender: PrivateKey.fromRandom().toPublicKey().toString(),
      token: withIndex,
      outputIndex: 1
    }
    expect(incoming.token.outputIndex).toBe(1)
  })

  it('discriminates payment request messages on `cancelled`', () => {
    const msgs: PaymentRequestMessage[] = [
      {
        requestId: 'r1',
        senderIdentityKey: 'k',
        amount: 5,
        description: 'coffee',
        expiresAt: 1,
        requestProof: 'p'
      },
      { requestId: 'r1', senderIdentityKey: 'k', cancelled: true, requestProof: 'p' }
    ]
    const kinds = msgs.map(m => (m.cancelled === true ? 'cancel' : `new:${m.amount}`))
    expect(kinds).toEqual(['new:5', 'cancel'])
    const response: PaymentRequestResponse = { requestId: 'r1', status: 'paid', amountPaid: 5 }
    const listed: IncomingPaymentRequest = {
      messageId: 'm',
      sender: 'k',
      requestId: 'r1',
      amount: 5,
      description: 'coffee',
      expiresAt: 1
    }
    expect(response.status).toBe('paid')
    expect(listed.requestId).toBe('r1')
  })
})

describe('root entry', () => {
  it('re-exports the shared types, constants and utilities', () => {
    expect(barrel.VERSION).toBe('0.1.0')
    expect(barrel.WebRTPayError).toBe(WebRTPayError)
    expect(barrel.Emitter).toBe(Emitter)
    expect(barrel.isIdentityKey).toBe(isIdentityKey)
    expect(barrel.DEFAULTS).toBe(DEFAULTS)
    expect(barrel.CHANNEL_LABEL).toBe(CHANNEL_LABEL)
    expect(barrel.CODE_PREFIX).toBe(CODE_PREFIX)
    expect(barrel.toBase64Url).toBe(toBase64Url)
    expect(barrel.randomBytes).toBe(randomBytes)
  })
})
