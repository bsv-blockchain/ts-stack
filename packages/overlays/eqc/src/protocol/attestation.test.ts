import { CompletedProtoWallet, PrivateKey, Utils } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'

import {
  attestationPreimage,
  deliveryPreimage,
  parseAttestation,
  parseDelivery,
  signAttestation,
  signDelivery,
  verifyAttestation,
  verifyDelivery
} from './attestation.js'
import { contentHash } from './payloads.js'

const hostKey = PrivateKey.fromRandom()
const hostWallet = new CompletedProtoWallet(hostKey)
const host = hostKey.toPublicKey().toString()
const queryId = 'a4'.repeat(32)
const payload = Utils.toArray('[]', 'utf8')
const hash = contentHash(payload)

function fields(): {
  queryId: string
  host: string
  contentHash: string
  payloadSize: number
  quotedFeeSats: number
  attestedAt: string
} {
  return {
    queryId,
    host,
    contentHash: hash,
    payloadSize: payload.length,
    quotedFeeSats: 1000,
    attestedAt: '2026-09-18T18:59:01.233Z'
  }
}

describe('preimages', () => {
  it('match the BRC-178 text layout and are domain separated', () => {
    expect(Utils.toUTF8(attestationPreimage(fields()))).toBe(
      `BRC-178 attestation\n${queryId}\n${host}\n${hash}\n2`
    )
    expect(Utils.toUTF8(deliveryPreimage(fields()))).toBe(
      `BRC-178 payload\n${queryId}\n${host}\n${hash}\n2`
    )
  })
})

describe('attestations', () => {
  it('sign, survive a JSON round trip, and verify', async () => {
    const attestation = await signAttestation(hostWallet, {
      ...fields(),
      anchors: [{ topic: 'tm_example', blockHeight: 850_000, tac: 'cd'.repeat(32) }]
    })
    const parsed = parseAttestation(JSON.parse(JSON.stringify(attestation)))
    expect(parsed).toEqual(attestation)
    expect(verifyAttestation(parsed, { queryId, host })).toBe('ok')
  })

  it('report the specific failure', async () => {
    const attestation = await signAttestation(hostWallet, fields())
    expect(verifyAttestation(attestation, { queryId: 'b5'.repeat(32), host })).toBe('wrong-query')
    const other = PrivateKey.fromRandom().toPublicKey().toString()
    expect(verifyAttestation(attestation, { queryId, host: other })).toBe('identity-mismatch')
    expect(verifyAttestation({ ...attestation, payloadSize: 3 }, { queryId, host })).toBe(
      'bad-signature'
    )
  })

  it('reject a signature made by a different key than the named host', async () => {
    const impostor = new CompletedProtoWallet(PrivateKey.fromRandom())
    const forged = await signAttestation(impostor, fields())
    expect(verifyAttestation(forged, { queryId, host })).toBe('identity-mismatch')
  })

  it('ignore a backdated attestedAt, which is not signed', async () => {
    const attestation = await signAttestation(hostWallet, fields())
    expect(
      verifyAttestation(
        { ...attestation, attestedAt: '1999-01-01T00:00:00.000Z' },
        { queryId, host }
      )
    ).toBe('ok')
  })

  it('parse strictly but drop malformed anchors', async () => {
    const attestation = await signAttestation(hostWallet, fields())
    expect(() => parseAttestation({ ...attestation, type: 'other' })).toThrow(TypeError)
    expect(() => parseAttestation({ ...attestation, payloadSize: -1 })).toThrow(TypeError)
    expect(() => parseAttestation({ ...attestation, signature: 'zz' })).toThrow(TypeError)
    expect(parseAttestation({ ...attestation, anchors: [{ topic: 5 }] }).anchors).toBeUndefined()
  })
})

describe('deliveries', () => {
  it('sign, parse, and return the verified bytes', async () => {
    const delivery = await signDelivery(hostWallet, { queryId, host, payload, supplement: [1, 2] })
    const parsed = parseDelivery(JSON.parse(JSON.stringify(delivery)))
    expect(verifyDelivery(parsed, { queryId, host, contentHash: hash })).toEqual({
      verdict: 'ok',
      payload,
      supplement: [1, 2]
    })
  })

  it('detect bytes that do not match the committed hash', async () => {
    const wrong = await signDelivery(hostWallet, { queryId, host, payload: [1, 2, 3] })
    expect(verifyDelivery(wrong, { queryId, host, contentHash: hash })).toEqual({
      verdict: 'hash-mismatch'
    })
  })

  it('refuse an attestation signature replayed as a delivery signature', async () => {
    const attestation = await signAttestation(hostWallet, fields())
    const delivery = await signDelivery(hostWallet, { queryId, host, payload })
    const replayed = { ...delivery, signature: attestation.signature }
    expect(verifyDelivery(replayed, { queryId, host, contentHash: hash })).toEqual({
      verdict: 'bad-signature'
    })
  })

  it('reject non-canonical base64', async () => {
    const delivery = await signDelivery(hostWallet, { queryId, host, payload })
    expect(() => parseDelivery({ ...delivery, payload: 'W10' })).toThrow(TypeError)
  })
})
