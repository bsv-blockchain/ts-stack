import { PrivateKey } from '@bsv/sdk'
import fc from 'fast-check'

import { DID, isCompressedPublicKey } from '../did'

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

const lowercaseTxid = fc.stringMatching(/^[0-9a-f]{64}$/)

describe('DID parser properties', () => {
  it('round-trips every lowercase transaction identifier', () => {
    fc.assert(
      fc.property(lowercaseTxid, txid => {
        const did = DID.fromTxid(txid)
        expect(did).toBe(`did:bsv:${txid}`)
        expect(DID.parse(did)).toEqual({ method: 'bsv', identifier: txid })
        expect(DID.isValid(did)).toBe(true)
      })
    )
  })

  it('accepts generated compressed secp256k1 identity keys', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 0x7fffffff }), scalar => {
        const identityKey = new PrivateKey(scalar).toPublicKey().toString()
        const did = `did:bsv:${identityKey}`
        expect(DID.parse(did)).toEqual({ method: 'bsv', identifier: identityKey })
        expect(DID.fromIdentityKey(identityKey).id).toBe(did)
      })
    )
  })

  it('keeps validation total and consistent with parsing for arbitrary text', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 4096 }), value => {
        expect(() => DID.isValid(value)).not.toThrow()
        if (DID.isValid(value)) {
          expect(() => DID.parse(value)).not.toThrow()
        } else {
          expect(() => DID.parse(value)).toThrow()
        }
      })
    )
  })

  it('rejects uppercase transaction identifiers and invalid public-key shapes', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[0-9A-F]{64}$/),
        fc.stringMatching(/^[4-9a-fA-F][0-9a-fA-F]{65}$/),
        (uppercaseTxid, invalidPublicKey) => {
          fc.pre(/[A-F]/.test(uppercaseTxid))
          expect(DID.isValid(`did:bsv:${uppercaseTxid}`)).toBe(false)
          expect(DID.isValid(`did:bsv:${invalidPublicKey}`)).toBe(false)
        }
      )
    )
  })

  it('rejects prefix/suffix smuggling and invalid compressed curve points', () => {
    const txid = 'a'.repeat(64)
    const invalidCurvePoint = `02${'0'.repeat(64)}`

    expect(() => DID.parse('')).toThrow('Invalid DID: must start with "did:bsv:"')
    expect(() => DID.parse(`xdid:bsv:${txid}`)).toThrow(
      'Invalid DID: must start with "did:bsv:"'
    )
    expect(() => DID.parse(`did:bsv:${txid}0`)).toThrow('identifier must be')
    expect(() => DID.fromTxid(`0${txid}`)).toThrow('Invalid txid')
    expect(() => DID.fromTxid(`${txid}0`)).toThrow('Invalid txid')
    expect(DID.isValid(`did:bsv:${invalidCurvePoint}`)).toBe(false)
    expect(isCompressedPublicKey(invalidCurvePoint)).toBe(false)
    expect(() => DID.fromIdentityKey(invalidCurvePoint)).toThrow(
      'valid compressed secp256k1 public key'
    )
  })
})
