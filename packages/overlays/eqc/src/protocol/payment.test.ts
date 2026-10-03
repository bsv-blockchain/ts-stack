import { CompletedProtoWallet, PrivateKey, Utils } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'

import {
  BRC29_PROTOCOL_ID,
  derivationPrefix,
  derivationSuffix,
  parsePaymentEnvelope,
  paymentEnvelope,
  payoutLockingScript
} from './payment.js'

const queryId = 'a4'.repeat(32)

describe('derivation encoding', () => {
  it('pins the BRC-29 protocol', () => {
    expect(BRC29_PROTOCOL_ID).toEqual([2, '3241645161d8'])
  })

  it('encodes the query ID bytes as standard base64', () => {
    expect(Utils.toHex(Utils.toArray(derivationPrefix(queryId), 'base64'))).toBe(queryId)
    expect(() => derivationPrefix('abc')).toThrow(TypeError)
  })

  it('encodes the rank as two big-endian bytes', () => {
    expect(derivationSuffix(1)).toBe('AAE=')
    expect(derivationSuffix(5)).toBe('AAU=')
    expect(derivationSuffix(256)).toBe('AQA=')
    expect(() => derivationSuffix(0)).toThrow(RangeError)
    expect(() => derivationSuffix(65_536)).toThrow(RangeError)
    expect(() => derivationSuffix(1.5)).toThrow(RangeError)
  })
})

describe('payoutLockingScript', () => {
  const payerKey = PrivateKey.fromRandom()
  const hostKey = PrivateKey.fromRandom()
  const payer = new CompletedProtoWallet(payerKey)
  const host = new CompletedProtoWallet(hostKey)
  const payerId = payerKey.toPublicKey().toString()
  const hostId = hostKey.toPublicKey().toString()

  it('derives the same script for payer and payee', async () => {
    const paid = await payoutLockingScript(payer, hostId, queryId, 2, false)
    const claimed = await payoutLockingScript(host, payerId, queryId, 2, true)
    expect(paid).toBe(claimed)
    expect(paid).toMatch(/^76a914[0-9a-f]{40}88ac$/)
  })

  it('binds the script to one query and one rank', async () => {
    const base = await payoutLockingScript(payer, hostId, queryId, 2, false)
    expect(await payoutLockingScript(payer, hostId, queryId, 3, false)).not.toBe(base)
    expect(await payoutLockingScript(payer, hostId, 'b5'.repeat(32), 2, false)).not.toBe(base)
  })
})

describe('payment envelopes', () => {
  it('round-trip through JSON', () => {
    const envelope = paymentEnvelope(queryId, 3, [1, 2, 3])
    expect(envelope).toEqual({
      derivationPrefix: derivationPrefix(queryId),
      derivationSuffix: 'AAM=',
      transaction: 'AQID'
    })
    expect(parsePaymentEnvelope(JSON.parse(JSON.stringify(envelope)))).toEqual(envelope)
  })

  it('reject missing fields, URL-safe base64, and unpadded base64', () => {
    const envelope = paymentEnvelope(queryId, 1, [1, 2, 3])
    expect(() => parsePaymentEnvelope({ ...envelope, transaction: undefined })).toThrow(TypeError)
    expect(() => parsePaymentEnvelope({ ...envelope, derivationPrefix: 'a-_b' })).toThrow(TypeError)
    expect(() => parsePaymentEnvelope({ ...envelope, derivationSuffix: 'AAE' })).toThrow(TypeError)
    expect(() => parsePaymentEnvelope('envelope')).toThrow(TypeError)
  })
})
