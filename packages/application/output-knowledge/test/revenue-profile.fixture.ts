import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import {
  Beef,
  Hash,
  Utils,
  Transaction,
  LockingScript,
  UnlockingScript,
  PrivateKey,
  ProtoWallet,
  P2PKH,
  type OutputPurchasePrepare,
  type OutputSignedPurchaseTerms,
  type OutputPurchaseSubmit
} from '@bsv/sdk'
import {
  RevenueListingProfile,
  type RevenueListingProfileDescriptor
} from '@bsv/sdk/script/templates/RevenueListingProfile'
import { RevenueListingProfileSpend } from '@bsv/sdk/script/templates/RevenueListingProfileSpend'
import type { RevenueListingProfileAction } from '@bsv/sdk/script/templates/RevenueListingProfilePlan'
import { assembleLineage, lineageLimits } from '../src/revenue-listing/LineagePackage.js'
import type { RevenueListingProfileLineagePackage } from '../src/revenue-listing/ProfileLineagePackage.js'
import type { ChainViewResolver } from '../src/SDKEvidenceVerifier.js'
import type { VerificationContext } from '../src/ports.js'

const raw = gunzipSync(
  readFileSync(new URL('./fixtures/revenue-listing/current-profile.json.gz', import.meta.url))
)
export const fixture: {
  descriptor: RevenueListingProfileDescriptor
  headers: { height: number; raw: string; hash: string; merkleRoot: string }[]
  transactions: Record<string, { label: string; raw: string; beef: string }>
  genesis: RevenueListingProfileLineagePackage['genesis']
  acquisitions: {
    prepare: OutputPurchasePrepare
    terms: OutputSignedPurchaseTerms
    submit: OutputPurchaseSubmit
    lineage: RevenueListingProfileLineagePackage
    purchaseCommitment: string
  }[]
  testActors: { seller: { scalar: number }; funding: { scalar: number } }
} = JSON.parse(raw.toString('utf8'))
export const fixtureDigest = createHash('sha256').update(raw).digest('hex')
const prepared = fixture.acquisitions[0].lineage
const assembly = assembleLineage(prepared, lineageLimits({}))
const stage = assembly.transactions.get(prepared.genesis.body.genesis.txid)!
const active = assembly.transactions.get(prepared.target.txid)!
export const profile = new RevenueListingProfile(
  stage.outputs[0].lockingScript.toBinary().slice(721),
  active.outputs[0].lockingScript.toBinary().slice(721)
)

// Disclosed easy-work ancestry, preserved normative headers followed by a
// reproducible extension for coinbase maturity. This is not mainnet evidence.
const headers = fixture.headers.map(header => ({ ...header }))
while (headers.length <= 101) {
  const previous = headers.at(-1)!,
    bytes = Uint8Array.from(Utils.toArray(previous.raw, 'hex'))
  bytes.set(Utils.toArray(previous.hash, 'hex').reverse(), 4)
  const view = new DataView(bytes.buffer)
  view.setUint32(68, view.getUint32(68, true) + 600, true)
  let hash = '',
    nonce = 0
  do {
    view.setUint32(76, nonce++, true)
    hash = Utils.toHex(Hash.hash256(Array.from(bytes)).reverse())
  } while (BigInt('0x' + hash) > 0x7fffffn << 232n)
  headers.push({
    height: headers.length,
    raw: Utils.toHex(Array.from(bytes)),
    hash,
    merkleRoot: Utils.toHex(Array.from(bytes.slice(36, 68)).reverse())
  })
}
export function context(): VerificationContext {
  const now = Math.floor(Date.now() / 1000)
  return {
    id: 'current-profile-101',
    partition: { application: 'current-profile', account: 'synthetic', access: 'test' },
    generation: '0',
    view: {
      id: 'current-profile-easy-work-101',
      chain: structuredClone(fixture.descriptor.chain),
      tipHash: headers[101].hash,
      tipHeight: '101',
      medianTimePast: String(
        new DataView(Uint8Array.from(Utils.toArray(headers[96].raw, 'hex')).buffer).getUint32(
          68,
          true
        )
      ),
      chainPolicyDigest: '11'.repeat(32)
    },
    policyDigest: '22'.repeat(32),
    now: String(now),
    limits: { bytes: 2097152, transactions: 4096, dependencies: 16384, deadline: String(now + 60) }
  }
}
export const chains: ChainViewResolver = {
  resolve: view =>
    Promise.resolve({
      view,
      tracker: {
        currentHeight: () => Promise.resolve(101),
        isValidRootForHeight: (root, height) =>
          Promise.resolve(headers[height]?.merkleRoot === root)
      },
      header: height =>
        headers[height]
          ? Promise.resolve(headers[height])
          : Promise.reject(new Error('Missing fixture header'))
    })
}
export function atGenesis(): RevenueListingProfileLineagePackage {
  const txid = prepared.genesis.body.genesis.txid
  return {
    ...structuredClone(prepared),
    target: structuredClone(prepared.genesis.body.genesis),
    transactions: [{ txid, beef: Utils.toBase64(assembly.beef.toBinaryAtomic(txid)) }]
  }
}
export function purchased(index = 0): RevenueListingProfileLineagePackage {
  const acquisition = fixture.acquisitions[index]
  return {
    ...structuredClone(acquisition.lineage),
    target: { ...acquisition.prepare.listing, txid: acquisition.submit.txid, outputIndex: 0 },
    transactions: [
      ...acquisition.lineage.transactions,
      { txid: acquisition.submit.txid, beef: acquisition.submit.beef }
    ].sort((a, b) => a.txid.localeCompare(b.txid))
  }
}
export function purchaseTransaction(index = 0) {
  const acquisition = fixture.acquisitions[index]
  return Beef.fromBinaryStrict(
    Utils.toArray(acquisition.submit.beef, 'base64')
  ).findTransactionForSigning(acquisition.submit.txid)!
}

/** Complete normal funded transitions, using disclosed offline actors. Seller
 * authority stays behind the wallet API; no derived private scalar is exported.
 */
export async function construct(
  previous: Transaction,
  outputIndex: number,
  selected: RevenueListingProfileAction,
  fee = 10,
  version = 1
) {
  const builder = new RevenueListingProfileSpend(
    profile,
    fixture.descriptor,
    [{ rawTransaction: previous.toHex(), outputIndex }],
    selected
  )
  const plan = builder.plan()
  const fundingIndex = previous.outputs.length - 1
  const transaction = new Transaction(
    version,
    [
      {
        sourceTransaction: previous,
        sourceTXID: previous.id('hex'),
        sourceOutputIndex: outputIndex,
        sequence: plan.listingSequence,
        unlockingScript: new UnlockingScript()
      },
      {
        sourceTransaction: previous,
        sourceTXID: previous.id('hex'),
        sourceOutputIndex: fundingIndex,
        sequence: 0xffffffff,
        unlockingScript: new UnlockingScript()
      }
    ],
    plan.outputs.map(output => ({
      satoshis: Number(output.satoshis),
      lockingScript: LockingScript.fromHex(output.lockingScript)
    })),
    plan.lockTime
  )
  const amount =
    previous.outputs[outputIndex].satoshis! +
    previous.outputs[fundingIndex].satoshis! -
    transaction.outputs.reduce((sum, output) => sum + output.satoshis!, 0) -
    fee
  if (amount <= 0) throw new Error('Insufficient fixture funding')
  transaction.addOutput({
    satoshis: amount,
    lockingScript: previous.outputs[fundingIndex].lockingScript
  })
  const prepared = builder.prepare(transaction),
    wallet = new ProtoWallet(new PrivateKey(fixture.testActors.seller.scalar)),
    signatures: { seller?: string } = {}
  const requests = prepared.signingRequests()
  if (requests.length > 1) throw new Error('Fixture permits at most one seller-child request')
  const request = requests[0]
  if (request !== undefined) {
    const key = await wallet.getPublicKey({
      protocolID: [...request.protocolID],
      keyID: request.keyID,
      counterparty: request.counterparty,
      forSelf: true
    })
    if (key.publicKey !== request.publicKey) throw new Error('Fixture child signer differs')
    const signed = await wallet.createSignature({
      protocolID: [...request.protocolID],
      keyID: request.keyID,
      counterparty: request.counterparty,
      data: request.data
    })
    signatures.seller = Utils.toHex([...signed.signature, request.scope])
  }
  const completed = prepared.complete(signatures)
  completed.inputs[1].unlockingScript = await new P2PKH()
    .unlock(new PrivateKey(fixture.testActors.funding.scalar))
    .sign(completed, 1)
  prepared.assertFinalLayout(completed)
  return completed
}

export function extend(
  packet: RevenueListingProfileLineagePackage,
  transaction: Transaction,
  outputIndex = 0
): RevenueListingProfileLineagePackage {
  const txid = transaction.id('hex')
  return {
    ...structuredClone(packet),
    target: { ...packet.target, txid, outputIndex },
    transactions: [
      ...packet.transactions,
      { txid, beef: Utils.toBase64(transaction.toAtomicBEEF()) }
    ].sort((a, b) => a.txid.localeCompare(b.txid))
  }
}
