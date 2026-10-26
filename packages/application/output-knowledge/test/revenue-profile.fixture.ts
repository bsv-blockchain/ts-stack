import { readFileSync } from 'node:fs'
import { fixturePromise } from './fixture-promise.js'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import {
  Beef,
  MerklePath,
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
while (headers.length <= 102) {
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
export function context(height = 101): VerificationContext {
  const now = Math.floor(Date.now() / 1000)
  return {
    id: `current-profile-${height}`,
    partition: { application: 'current-profile', account: 'synthetic', access: 'test' },
    generation: '0',
    view: {
      id: `current-profile-easy-work-${height}`,
      chain: structuredClone(fixture.descriptor.chain),
      tipHash: headers[height].hash,
      tipHeight: String(height),
      medianTimePast: String(
        new DataView(
          Uint8Array.from(Utils.toArray(headers[height - 5].raw, 'hex')).buffer
        ).getUint32(68, true)
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

/** Independently mined easy-work containing block, with the original ancestry
 * preserved byte for byte. Its historical MTP is the median of the eleven
 * preceding headers, never the selected tip's later observation time. */
export function includeAt102(packet: RevenueListingProfileLineagePackage) {
  const owned = structuredClone(packet),
    target = owned.target.txid,
    beef = Beef.fromBinaryStrict(
      Utils.toArray(owned.transactions.find(entry => entry.txid === target)!.beef, 'base64')
    ),
    path = new MerklePath(102, [
      [
        { offset: 0, hash: '01'.repeat(32) },
        { offset: 1, hash: target, txid: true }
      ]
    ]),
    root = path.computeRoot()
  beef.mergeBump(path)
  owned.transactions = owned.transactions.map(entry =>
    entry.txid === target
      ? { txid: target, beef: Utils.toBase64(beef.toBinaryAtomic(target)) }
      : entry
  )
  const bytes = Uint8Array.from(Utils.toArray(headers[102].raw, 'hex')),
    data = new DataView(bytes.buffer)
  bytes.set(Utils.toArray(root, 'hex').reverse(), 36)
  let hash = '',
    nonce = 0
  do {
    data.setUint32(76, nonce++, true)
    hash = Utils.toHex(Hash.hash256(Array.from(bytes)).reverse())
  } while (BigInt('0x' + hash) > 0x7fffffn << 232n)
  const containing = { height: 102, raw: Utils.toHex(Array.from(bytes)), hash, merkleRoot: root },
    selected = context(102)
  selected.view.tipHash = hash
  const times = headers
      .slice(91, 102)
      .map(header =>
        new DataView(Uint8Array.from(Utils.toArray(header.raw, 'hex')).buffer).getUint32(68, true)
      )
      .sort((a, b) => a - b),
    historicalMTP = String(times[5])
  const resolver: ChainViewResolver = {
    resolve: view =>
      fixturePromise(() => ({
        view,
        tracker: {
          currentHeight: () => Promise.resolve(102),
          isValidRootForHeight: (root, height) =>
            fixturePromise(
              () => root === (height === 102 ? containing : headers[height])?.merkleRoot
            )
        },
        header: height =>
          fixturePromise(() => {
            const header = height === 102 ? containing : headers[height]
            if (!header) throw new Error('Missing fixture header')
            return header
          }),
        medianTimePastBefore: height =>
          fixturePromise(() => {
            if (height !== 102) throw new Error('Unexpected containing height')
            return historicalMTP
          })
      }))
  }
  return { packet: owned, context: selected, chains: resolver, historicalMTP }
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
  version = 1,
  header?: { lockTime: number; listingSequence: number; fundingSequence: number }
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
        sequence: header?.listingSequence ?? plan.listingSequence,
        unlockingScript: new UnlockingScript()
      },
      {
        sourceTransaction: previous,
        sourceTXID: previous.id('hex'),
        sourceOutputIndex: fundingIndex,
        sequence: header?.fundingSequence ?? 0xffffffff,
        unlockingScript: new UnlockingScript()
      }
    ],
    plan.outputs.map(output => ({
      satoshis: Number(output.satoshis),
      lockingScript: LockingScript.fromHex(output.lockingScript)
    })),
    header?.lockTime ?? plan.lockTime
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
  const prepared =
      header === undefined
        ? builder.prepare(transaction)
        : builder.preparePreservingHeader(transaction),
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
