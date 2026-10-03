import { Utils, type WalletInterface } from '@bsv/sdk'

import { signBRC77, verifyBRC77 } from './brc77.js'
import { isCanonicalBase64 } from './encoding.js'
import { contentHash } from './payloads.js'
import { isHashHex, isPlainObject, isPublicKeyHex } from './query.js'

const ATTESTATION_TAG = 'BRC-178 attestation'
const DELIVERY_TAG = 'BRC-178 payload'
const SIGNATURE_HEX = /^(?:[0-9a-f]{2}){1,256}$/
const MAX_ANCHORS = 32

export interface TopicAnchor {
  topic: string
  blockHeight: number
  blockHash?: string
  tac: string
}

export interface SignedFields {
  queryId: string
  host: string
  contentHash: string
  payloadSize: number
}

export interface Attestation extends SignedFields {
  type: 'attest'
  quotedFeeSats: number
  attestedAt: string
  signature: string
  anchors?: TopicAnchor[]
}

export interface Delivery extends SignedFields {
  type: 'payload'
  payload: string
  supplement?: string
  signature: string
}

export type Verdict = 'ok' | 'wrong-query' | 'identity-mismatch' | 'bad-signature' | 'hash-mismatch'

function preimage(tag: string, fields: SignedFields): number[] {
  return Utils.toArray(
    [tag, fields.queryId, fields.host, fields.contentHash, String(fields.payloadSize)].join('\n'),
    'utf8'
  )
}

export function attestationPreimage(fields: SignedFields): number[] {
  return preimage(ATTESTATION_TAG, fields)
}

export function deliveryPreimage(fields: SignedFields): number[] {
  return preimage(DELIVERY_TAG, fields)
}

export async function signAttestation(
  wallet: WalletInterface,
  fields: SignedFields & { quotedFeeSats: number; attestedAt: string; anchors?: TopicAnchor[] },
  originator?: string
): Promise<Attestation> {
  const signature = await signBRC77(wallet, attestationPreimage(fields), originator)
  const attestation: Attestation = {
    type: 'attest',
    queryId: fields.queryId,
    host: fields.host,
    contentHash: fields.contentHash,
    payloadSize: fields.payloadSize,
    quotedFeeSats: fields.quotedFeeSats,
    attestedAt: fields.attestedAt,
    signature: Utils.toHex(signature)
  }
  if (fields.anchors !== undefined && fields.anchors.length > 0) {
    attestation.anchors = fields.anchors
  }
  return attestation
}

export async function signDelivery(
  wallet: WalletInterface,
  fields: { queryId: string; host: string; payload: number[]; supplement?: number[] },
  originator?: string
): Promise<Delivery> {
  const signed: SignedFields = {
    queryId: fields.queryId,
    host: fields.host,
    contentHash: contentHash(fields.payload),
    payloadSize: fields.payload.length
  }
  const signature = await signBRC77(wallet, deliveryPreimage(signed), originator)
  const delivery: Delivery = {
    type: 'payload',
    ...signed,
    payload: Utils.toBase64(fields.payload),
    signature: Utils.toHex(signature)
  }
  if (fields.supplement !== undefined && fields.supplement.length > 0) {
    delivery.supplement = Utils.toBase64(fields.supplement)
  }
  return delivery
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function parseSignedFields(value: Record<string, unknown>): SignedFields & { signature: string } {
  if (!isHashHex(value.queryId)) throw new TypeError('queryId must be 32 bytes of hex')
  if (!isPublicKeyHex(value.host)) throw new TypeError('host must be a compressed public key')
  if (!isHashHex(value.contentHash)) throw new TypeError('contentHash must be 32 bytes of hex')
  if (!nonNegativeInteger(value.payloadSize)) {
    throw new TypeError('payloadSize must be a non-negative integer')
  }
  if (typeof value.signature !== 'string' || !SIGNATURE_HEX.test(value.signature)) {
    throw new TypeError('signature must be lowercase hex')
  }
  return {
    queryId: value.queryId,
    host: value.host,
    contentHash: value.contentHash,
    payloadSize: value.payloadSize,
    signature: value.signature
  }
}

function parseAnchors(value: unknown): TopicAnchor[] | undefined {
  if (!Array.isArray(value)) return undefined
  const anchors: TopicAnchor[] = []
  for (const item of value.slice(0, MAX_ANCHORS)) {
    if (
      !isPlainObject(item) ||
      typeof item.topic !== 'string' ||
      item.topic.length === 0 ||
      item.topic.length > 256 ||
      typeof item.blockHeight !== 'number' ||
      !Number.isSafeInteger(item.blockHeight) ||
      item.blockHeight < -1 ||
      !isHashHex(item.tac)
    ) {
      continue
    }
    const anchor: TopicAnchor = { topic: item.topic, blockHeight: item.blockHeight, tac: item.tac }
    if (isHashHex(item.blockHash)) anchor.blockHash = item.blockHash
    anchors.push(anchor)
  }
  return anchors.length > 0 ? anchors : undefined
}

/** Validates an untrusted attestation. Anchors are an extension, so bad anchors are dropped. */
export function parseAttestation(value: unknown): Attestation {
  if (!isPlainObject(value) || value.type !== 'attest') {
    throw new TypeError('Attestation must be an object of type attest')
  }
  const signed = parseSignedFields(value)
  if (!nonNegativeInteger(value.quotedFeeSats)) {
    throw new TypeError('quotedFeeSats must be a non-negative integer')
  }
  if (typeof value.attestedAt !== 'string' || value.attestedAt.length > 64) {
    throw new TypeError('attestedAt must be a short string')
  }
  const attestation: Attestation = {
    type: 'attest',
    queryId: signed.queryId,
    host: signed.host,
    contentHash: signed.contentHash,
    payloadSize: signed.payloadSize,
    quotedFeeSats: value.quotedFeeSats,
    attestedAt: value.attestedAt,
    signature: signed.signature
  }
  const anchors = parseAnchors(value.anchors)
  if (anchors !== undefined) attestation.anchors = anchors
  return attestation
}

export function parseDelivery(value: unknown): Delivery {
  if (!isPlainObject(value) || value.type !== 'payload') {
    throw new TypeError('Delivery must be an object of type payload')
  }
  const signed = parseSignedFields(value)
  if (!isCanonicalBase64(value.payload)) throw new TypeError('payload must be canonical base64')
  const delivery: Delivery = {
    type: 'payload',
    queryId: signed.queryId,
    host: signed.host,
    contentHash: signed.contentHash,
    payloadSize: signed.payloadSize,
    payload: value.payload,
    signature: signed.signature
  }
  if (value.supplement !== undefined) {
    if (!isCanonicalBase64(value.supplement)) {
      throw new TypeError('supplement must be canonical base64')
    }
    delivery.supplement = value.supplement
  }
  return delivery
}

function verifySignature(
  signedBytes: number[],
  fields: SignedFields & { signature: string }
): Verdict {
  const result = verifyBRC77(signedBytes, Utils.toArray(fields.signature, 'hex'))
  if (!result.valid) return 'bad-signature'
  return result.signer === fields.host ? 'ok' : 'identity-mismatch'
}

/** `expected.host` is the BRC-103 session identity the attestation arrived under. */
export function verifyAttestation(
  attestation: Attestation,
  expected: { queryId: string; host: string }
): Verdict {
  if (attestation.queryId !== expected.queryId) return 'wrong-query'
  if (attestation.host !== expected.host) return 'identity-mismatch'
  return verifySignature(attestationPreimage(attestation), attestation)
}

export function verifyDelivery(
  delivery: Delivery,
  expected: { queryId: string; host: string; contentHash: string }
):
  { verdict: 'ok'; payload: number[]; supplement: number[] } | { verdict: Exclude<Verdict, 'ok'> } {
  if (delivery.queryId !== expected.queryId) return { verdict: 'wrong-query' }
  if (delivery.host !== expected.host) return { verdict: 'identity-mismatch' }
  const payload = Utils.toArray(delivery.payload, 'base64')
  if (
    delivery.contentHash !== expected.contentHash ||
    delivery.payloadSize !== payload.length ||
    contentHash(payload) !== expected.contentHash
  ) {
    return { verdict: 'hash-mismatch' }
  }
  const verdict = verifySignature(deliveryPreimage(delivery), delivery)
  if (verdict !== 'ok') return { verdict }
  const supplement =
    delivery.supplement === undefined ? [] : Utils.toArray(delivery.supplement, 'base64')
  return { verdict: 'ok', payload, supplement }
}
