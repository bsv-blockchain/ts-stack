import { Hash, PrivateKey, ProtoWallet, Utils } from '@bsv/sdk'

import { attestationPreimage, deliveryPreimage } from '../../src/protocol/attestation.js'
import { verifyBRC77 } from '../../src/protocol/brc77.js'
import { canonicalJson, compareCodeUnits } from '../../src/protocol/canonicalJson.js'
import {
  contentHash,
  encodeMessageList,
  encodeOutpointList,
  type CanonicalMessage,
  type LookupOutpoint
} from '../../src/protocol/payloads.js'
import {
  derivationPrefix,
  derivationSuffix,
  payoutLockingScript
} from '../../src/protocol/payment.js'
import { computeQueryId, type EconomicQuery } from '../../src/protocol/query.js'
import {
  computePayouts,
  minimumFeeForAllRanks,
  requiredShare,
  squareRootWeights,
  sumOfWeights
} from '../../src/protocol/weights.js'
import { PayerWallet } from '../support/wallets.js'

/** Public test keys derived from fixed labels. Anyone can rebuild them; never fund them. */
function testKey(label: string): PrivateKey {
  return new PrivateKey(Utils.toHex(Hash.sha256(Utils.toArray(label, 'utf8'))), 'hex')
}

/** The IEEE-754 binary64 bits of `value`, big-endian hex, so a float is pinned exactly. */
function float64Hex(value: number): string {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value)
  return Utils.toHex(Array.from(new Uint8Array(view.buffer)))
}

/** BRC-77 for anyone, as `signBRC77` produces it, but with a fixed key ID so the bytes repeat. */
async function signFixed(key: PrivateKey, message: number[], keyID: number[]): Promise<number[]> {
  const wallet = new ProtoWallet(key)
  const { signature } = await wallet.createSignature({
    data: message,
    protocolID: [2, 'message signing'],
    keyID: Utils.toBase64(keyID),
    counterparty: 'anyone'
  })
  return [
    0x42,
    0x42,
    0x33,
    0x01,
    ...key.toPublicKey().encode(true),
    0,
    ...keyID,
    ...signature
  ] as number[]
}

const PAYOUT_CASES: Array<[number, number]> = [
  [12, 5],
  [20, 3],
  [2, 5],
  [1000, 1],
  [1000, 3],
  [1000, 5],
  [1001, 5],
  [1002, 5],
  [987_654_321, 17],
  [2_100_000_000_000_000, 64]
]

const SUFFIX_RANKS = [1, 2, 3, 4, 5, 64, 256, 65535]

export async function buildVectors(): Promise<Record<string, unknown>> {
  const client = testKey('BRC-178 test vector client')
  const hosts = [1, 2, 3].map(n => testKey(`BRC-178 test vector host ${n}`))
  const clientKey = client.toPublicKey().toString()
  const hostKeys = hosts.map(host => host.toPublicKey().toString())

  const query: EconomicQuery = {
    type: 'message-list',
    client: clientKey,
    hostSetHint: [...hostKeys].sort(compareCodeUnits),
    params: { recipient: clientKey, messageBox: 'payment_inbox' },
    maxFeeSats: 2000,
    floorFeeSats: 1000,
    threshold: 3,
    topK: 5,
    raceMs: 400,
    expires: '2026-09-18T19:05:00.000Z',
    nonce: '11'.repeat(32)
  }
  const nested: EconomicQuery = {
    type: 'overlay-lookup',
    client: clientKey,
    strictHosts: true,
    hostSetHint: [...hostKeys].sort(compareCodeUnits),
    params: { service: 'ls_example', query: { z: [3, 1, 2], a: { y: 'é', b: null, x: true } } },
    maxFeeSats: 5000,
    floorFeeSats: 1000,
    threshold: 1,
    topK: 1,
    raceMs: 0,
    expires: '2026-09-18T19:05:00.000Z',
    nonce: 'ab'.repeat(32)
  }
  const queryId = computeQueryId(query)

  const messages: CanonicalMessage[] = [
    { messageId: 'b2', sender: hostKeys[1], body: '{"amount":2}' },
    { messageId: 'a1', sender: hostKeys[0], body: 'hello "world"\n' },
    { messageId: '😀', sender: hostKeys[2], body: 'astral' },
    { messageId: '￿', sender: hostKeys[2], body: 'last BMP code unit' }
  ]
  const messageList = encodeMessageList(messages)
  const emptyList = encodeMessageList([])

  const txidA = 'aa'.repeat(32)
  const txidB = '0f'.repeat(32)
  const outpoints: LookupOutpoint[] = [
    { txid: txidA, outputIndex: 1 },
    { txid: txidB, outputIndex: 300, context: [1, 2, 3] },
    { txid: txidA, outputIndex: 0, context: [0xff] },
    { txid: txidA, outputIndex: 1 }
  ]
  const outpointList = encodeOutpointList(outpoints)

  const signedFields = {
    queryId,
    host: hostKeys[0],
    contentHash: contentHash(messageList),
    payloadSize: messageList.length
  }
  const attestPreimage = attestationPreimage(signedFields)
  const deliverPreimage = deliveryPreimage(signedFields)
  const attestKeyID = Array.from({ length: 32 }, (_, index) => index)
  const deliverKeyID = Array.from({ length: 32 }, (_, index) => 0xff - index)
  const attestSignature = await signFixed(hosts[0], attestPreimage, attestKeyID)
  const deliverSignature = await signFixed(hosts[0], deliverPreimage, deliverKeyID)
  for (const [message, signature] of [
    [attestPreimage, attestSignature],
    [deliverPreimage, deliverSignature]
  ]) {
    if (verifyBRC77(message, signature).valid !== true) throw new Error('vector does not verify')
  }

  const clientWallet = new PayerWallet(client)
  const payoutScripts = await Promise.all(
    hostKeys.map(async (hostKey, index) => ({
      rank: index + 1,
      host: hostKey,
      derivationSuffix: derivationSuffix(index + 1),
      lockingScriptHex: await payoutLockingScript(clientWallet, hostKey, queryId, index + 1, false)
    }))
  )

  return {
    notice:
      'Deterministic BRC-178 fixtures generated by @bsv/eqc. The private keys are SHA-256 of public labels and MUST NOT hold value.',
    keys: {
      derivation: 'privateKey = SHA-256(UTF-8 label)',
      client: { label: 'BRC-178 test vector client', publicKey: clientKey },
      hosts: hosts.map((_, index) => ({
        label: `BRC-178 test vector host ${index + 1}`,
        publicKey: hostKeys[index]
      }))
    },
    queryId: [query, nested].map(value => ({
      query: value,
      canonicalJson: canonicalJson(value),
      queryId: computeQueryId(value)
    })),
    payouts: PAYOUT_CASES.map(([feeSats, k]) => ({
      feeSats,
      k,
      weightsFloat64Hex: squareRootWeights(k).map(float64Hex),
      sumOfWeightsFloat64Hex: float64Hex(sumOfWeights(k)),
      payouts: computePayouts(feeSats, k),
      requiredShares: Array.from({ length: k }, (_, index) => requiredShare(feeSats, k, index + 1))
    })),
    minimumFeeForAllRanks: [1, 2, 3, 5, 14, 64].map(k => ({
      k,
      feeSats: minimumFeeForAllRanks(k)
    })),
    derivation: {
      queryId,
      derivationPrefix: derivationPrefix(queryId),
      suffixes: SUFFIX_RANKS.map(rank => ({ rank, derivationSuffix: derivationSuffix(rank) })),
      payoutScripts
    },
    messageList: {
      messages,
      canonicalUtf8: Utils.toUTF8(messageList),
      canonicalHex: Utils.toHex(messageList),
      contentHash: contentHash(messageList),
      empty: { canonicalUtf8: Utils.toUTF8(emptyList), contentHash: contentHash(emptyList) }
    },
    outpointList: {
      outpoints,
      canonicalHex: Utils.toHex(outpointList),
      contentHash: contentHash(outpointList)
    },
    signatures: {
      signer: hostKeys[0],
      fields: signedFields,
      attestation: {
        preimageUtf8: Utils.toUTF8(attestPreimage),
        keyIDHex: Utils.toHex(attestKeyID),
        brc77Hex: Utils.toHex(attestSignature)
      },
      delivery: {
        preimageUtf8: Utils.toUTF8(deliverPreimage),
        keyIDHex: Utils.toHex(deliverKeyID),
        brc77Hex: Utils.toHex(deliverSignature)
      }
    }
  }
}
