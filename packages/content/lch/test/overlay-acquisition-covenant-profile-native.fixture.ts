import {
  Beef,
  canonicalOutputJSON,
  decodeOutputBytes,
  LockingScript,
  outputAssert,
  outputPacketDigest,
  P2PKH,
  PrivateKey,
  signOutputPacket,
  Transaction,
  UnlockingScript,
  Utils,
  type OutputPurchaseEnvelope,
  type OutputPurchaseSubmit,
  type OutputReleaseEvidence
} from '@bsv/sdk'
import { RevenueListingProfileSpend } from '@bsv/sdk/script/templates/RevenueListingProfileSpend'
import { revenueListingPurchaseCommitment } from '@bsv/sdk/script/templates/RevenueListingSpend'
import { afterEach } from '@jest/globals'
import { createSecretKey } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQLiteProtectedOperationObjectStore } from '../../../application/output-knowledge/src/operations/SQLiteProtectedOperationObjectStore.js'
import { NodeProtectedPayloadCodec } from '../../../application/output-knowledge/src/private/NodeProtectedPayloadCodec.js'
import { SDKPrivateReleaseEvidence } from '../../../application/output-knowledge/src/private/SDKPrivateReleaseEvidence.js'
import { RevenueListingProfileLineageVerifier } from '../../../application/output-knowledge/src/revenue-listing/RevenueListingProfileLineageVerifier.js'
import { RevenueListingProfilePurchaseVerifier } from '../../../application/output-knowledge/src/revenue-listing/RevenueListingProfilePurchaseVerifier.js'
import {
  assembleLineage,
  lineageLimits
} from '../../../application/output-knowledge/src/revenue-listing/LineagePackage.js'
import {
  chains,
  completeGenesis,
  context as bitcoinContext,
  minedChain,
  plainProvedEvidence,
  purchaseProof
} from '../../../application/output-knowledge/test/revenue-lineage-fixture.js'
import {
  parseRevenueListingProfileLineagePackage,
  type RevenueListingProfileLineagePackage
} from '../../../application/output-knowledge/src/revenue-listing/ProfileLineagePackage.js'
import { lchCovenantProfileFixture } from './overlay-acquisition-covenant-profile.fixture.js'
import { WalletBRC78KeyDelivery, type KeyGrant, type SignedObject } from '../src/index.js'
import { createLCHOverlayFixedRenderAgreement } from '../src/overlayAcquisitionPolicy.js'
import { LCH_OVERLAY_PROFILES, encodeLCHOverlayContext } from '../src/overlayAcquisitionCodec.js'
import { validateLCHOverlayCovenantProfileTerms } from '../src/overlayAcquisitionCovenantProfileTerms.js'
import {
  LCHOverlayCovenantProfileDomain,
  type LCHOverlayCovenantProfileDomainOptions
} from '../src/overlayAcquisitionCovenantProfile.js'
import { lchOverlayCustodyBinding } from '../src/overlayAcquisitionCustody.js'
import { profile as family } from '../../../application/output-knowledge/test/revenue-profile.fixture.js'

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  await [...cleanups].reduce((pending, close) => pending.then(close), Promise.resolve())
  cleanups.clear()
})

/** Current immutable reserve-stage/activation/purchase Scripts and actual encrypted
 * protected buyer custody, using the historical fixture ONLY for disclosed mature
 * funding ancestry and its synthetic header view, never its listing program.
 * Full disclosed synthetic Bitcoin/genesis/covenant and actual encrypted
 * native buyer custody. Funding is constructed from public fixture keys, not a
 * wallet action; topical admission, live chain outcome and wallet integration
 * are separate demonstrations. No broadcast, mainnet evidence or customer keys.
 */
export async function lchNativeCovenantProfileFixture(
  fixtureOptions: {
    detached?: boolean
    provenPurchase?: boolean
    maximumRequestBytes?: number
    maximumResponseBytes?: number
    revocations?: NonNullable<LCHOverlayCovenantProfileDomainOptions['revocations']>
  } = {}
) {
  const original = completeGenesis(),
    assembly = assembleLineage(original, lineageLimits({})),
    anchor = assembly.beef.findAtomicTransaction(original.descriptor.lineageAnchor.txid)!,
    f = await lchCovenantProfileFixture({
      chain: original.descriptor.chain,
      anchor: original.descriptor.lineageAnchor,
      embedCiphertext: fixtureOptions.detached !== true,
      maximumRequestBytes: fixtureOptions.maximumRequestBytes,
      maximumResponseBytes: fixtureOptions.maximumResponseBytes
    }),
    total = anchor.outputs[original.descriptor.lineageAnchor.outputIndex].satoshis!,
    genesis = new Transaction(
      1,
      [
        {
          sourceTransaction: anchor,
          sourceOutputIndex: original.descriptor.lineageAnchor.outputIndex,
          unlockingScriptTemplate: new P2PKH().unlock(new PrivateKey(41)),
          sequence: 0xffffffff
        }
      ],
      [
        {
          satoshis: Number(f.descriptor.reserve),
          lockingScript: family.lock('activation', f.descriptor)
        },
        { satoshis: 5000, lockingScript: new P2PKH().lock(f.buyerKey.toPublicKey().toAddress()) },
        {
          satoshis: total - 5001 - Number(f.descriptor.reserve),
          lockingScript: new P2PKH().lock(new PrivateKey(41).toPublicKey().toAddress())
        }
      ],
      0
    )
  await genesis.sign()
  const genesisPoint = {
      chain: original.descriptor.chain,
      txid: genesis.id('hex'),
      outputIndex: 0
    },
    activationBuilder = new RevenueListingProfileSpend(
      family,
      f.descriptor,
      [{ rawTransaction: genesis.toHex(), outputIndex: 0 }],
      { operation: 'activate' }
    ),
    activationPlan = activationBuilder.plan(),
    activationFunding = new Transaction(
      1,
      [
        {
          sourceTransaction: genesis,
          sourceOutputIndex: 0,
          unlockingScript: new UnlockingScript(),
          sequence: 0xffffffff
        },
        {
          sourceTransaction: genesis,
          sourceOutputIndex: 1,
          unlockingScript: new UnlockingScript(),
          sequence: 0xffffffff
        }
      ],
      [
        ...activationPlan.outputs.map(output => ({
          satoshis: Number(output.satoshis),
          lockingScript: LockingScript.fromHex(output.lockingScript)
        })),
        { satoshis: 4990, lockingScript: new P2PKH().lock(f.buyerKey.toPublicKey().toAddress()) }
      ],
      activationPlan.lockTime
    ),
    active = activationBuilder.prepare(activationFunding).complete({})
  active.inputs[0].sourceTransaction = genesis
  active.inputs[1].sourceTransaction = genesis
  active.inputs[1].unlockingScriptTemplate = new P2PKH().unlock(f.buyerKey)
  await active.sign()
  const point = { chain: original.descriptor.chain, txid: active.id('hex'), outputIndex: 0 },
    lineage: RevenueListingProfileLineagePackage = {
      version: 1,
      descriptor: f.descriptor,
      genesis: signOutputPacket(
        'sale-genesis',
        {
          version: 1 as const,
          listingId: outputPacketDigest('sale-listing', f.descriptor),
          genesis: genesisPoint
        },
        f.sellerKey
      ),
      target: point,
      transactions: [
        { txid: genesisPoint.txid, beef: Utils.toBase64(genesis.toAtomicBEEF()) },
        { txid: point.txid, beef: Utils.toBase64(active.toAtomicBEEF()) }
      ].sort((a, b) => a.txid.localeCompare(b.txid))
    }
  f.prepare.listing = point
  const json = (value: unknown) => new TextEncoder().encode(canonicalOutputJSON(value)),
    prepared = f.signedTerms({
      domainEvidence: {
        schema: 'https://bsv.brc.dev/tokens/0197#lineage-package-v1',
        bytes: Utils.toBase64(json(lineage))
      }
    }),
    spend = new RevenueListingProfileSpend(
      family,
      f.descriptor,
      [{ rawTransaction: active.toHex(), outputIndex: 0 }],
      {
        operation: 'purchase',
        acquisitionId: prepared.body.acquisitionId,
        requestDigest: prepared.body.requestDigest,
        recipient: prepared.body.recipient
      }
    ),
    plan = spend.plan(),
    funded = new Transaction(
      1,
      [
        {
          sourceTransaction: active,
          sourceOutputIndex: 0,
          unlockingScript: new UnlockingScript(),
          sequence: 0xffffffff
        },
        {
          sourceTransaction: active,
          sourceOutputIndex: 1,
          unlockingScript: new UnlockingScript(),
          sequence: 0xffffffff
        }
      ],
      [
        ...plan.outputs.map(output => ({
          satoshis: Number(output.satoshis),
          lockingScript: LockingScript.fromHex(output.lockingScript)
        })),
        { satoshis: 4800, lockingScript: new P2PKH().lock(f.buyerKey.toPublicKey().toAddress()) }
      ],
      0
    ),
    purchased = spend.prepare(funded).complete({})
  purchased.inputs[0].sourceTransaction = active
  purchased.inputs[1].sourceTransaction = active
  purchased.inputs[1].unlockingScriptTemplate = new P2PKH().unlock(f.buyerKey)
  await purchased.sign()
  const originalBeef = Beef.fromBinaryStrict(purchased.toAtomicBEEF()),
    selected =
      fixtureOptions.provenPurchase === true
        ? minedChain(purchaseProof(purchased.id('hex')).computeRoot(), 101)
        : undefined
  const purchaseBytes =
    fixtureOptions.provenPurchase === true
      ? plainProvedEvidence(originalBeef, purchased.id('hex'))
      : purchased.toAtomicBEEF()
  const purchase = {
      txid: purchased.id('hex'),
      outputIndex: 0,
      beef: Utils.toBase64(purchaseBytes)
    },
    submission: OutputPurchaseSubmit = {
      version: 1,
      acquisitionId: prepared.body.acquisitionId,
      txid: purchase.txid,
      beef: purchase.beef
    },
    purchaseCommitment = revenueListingPurchaseCommitment(purchased),
    release: OutputReleaseEvidence = {
      chain: point.chain,
      txid: purchase.txid,
      policy: { kind: 'local-admission' },
      acceptedAt: '20'
    },
    terms = await validateLCHOverlayCovenantProfileTerms(f.input),
    settlementBody = {
      version: 1 as const,
      seller: f.descriptor.seller,
      buyer: f.prepare.recipient,
      requestId: f.prepare.requestId,
      offerId: f.prepare.termsDigest,
      assetId: f.prepare.assetId,
      dutyUid: terms.policy.dutyUid,
      acquisitionId: prepared.body.acquisitionId,
      listingId: outputPacketDigest('sale-listing', f.descriptor),
      previous: point,
      successor: { ...point, txid: purchase.txid },
      txid: purchase.txid,
      purchaseCommitment,
      satoshis: f.descriptor.purchasePrice,
      releasePolicy: release.policy,
      releaseEvidenceDigest: outputPacketDigest('release-evidence', release),
      issuedAt: '21',
      recoveryUntil: prepared.body.recoveryUntil
    },
    settlement = signOutputPacket('lch-covenant-settlement', settlementBody, f.sellerKey),
    settlementId = outputPacketDigest('lch-covenant-settlement', settlementBody),
    sender = new WalletBRC78KeyDelivery(f.sellerWallet),
    keyGrants: KeyGrant[] = []
  await [...f.asset.keys].reduce(
    (pending, [key, cek]) =>
      pending.then(async () => {
        const keyId = Uint8Array.from(Utils.toArray(key, 'hex'))
        keyGrants.push({
          keyId,
          delivery: 'https://bsv.brc.dev/apps/0170#brc78-key-v1',
          payload: await sender.deliver(f.prepare.recipient, keyId, cek)
        })
      }),
    Promise.resolve()
  )
  const license = await f.issuer.issueLicense({
    assetId: f.asset.assetId,
    offerId: Uint8Array.from(Utils.toArray(f.prepare.termsDigest, 'hex')),
    requestId: Uint8Array.from(Utils.toArray(f.prepare.requestId, 'hex')),
    issuer: f.seller.identityKey,
    subject: f.buyer.identityKey,
    issuedAt: 22,
    agreement: await createLCHOverlayFixedRenderAgreement(terms.policy),
    selection: { type: 'all' },
    keyGrants,
    encryption: terms.encryption,
    fulfillments: [
      {
        dutyUid: terms.policy.dutyUid,
        settlementProfile: LCH_OVERLAY_PROFILES.collectorSettlement,
        receiptIds: [Uint8Array.from(Utils.toArray(settlementId, 'hex'))]
      }
    ],
    critical: [LCH_OVERLAY_PROFILES.acquisition, LCH_OVERLAY_PROFILES.collectorSettlement],
    extensions: {
      [LCH_OVERLAY_PROFILES.acquisition]: {
        version: 1,
        mode: 'listing-covenant',
        settlementId: Uint8Array.from(Utils.toArray(settlementId, 'hex'))
      },
      [LCH_OVERLAY_PROFILES.collectorSettlement]: { version: 1 }
    }
  })
  const content = {
    version: 1 as const,
    license,
    evidence: [{ type: 'offer' as const, object: f.offer }],
    settlement: json(settlement),
    purchaseEvidence: json({ version: 1, lineage, purchase, terms: prepared, release })
  }
  async function deliver(selectedLicense: SignedObject = license): Promise<OutputPurchaseEnvelope> {
    const secret = await encodeLCHOverlayContext(
      { ...content, license: selectedLicense },
      'listing-covenant'
    )
    return {
      result: {
        version: 1,
        status: 'delivered',
        acquisitionId: prepared.body.acquisitionId,
        txid: purchase.txid,
        purchaseCommitment,
        recoveryUntil: prepared.body.recoveryUntil,
        steak: { [f.prepare.topic]: { outputsToAdmit: [0], coinsToRetain: [], coinsRemoved: [0] } },
        potatoes: signOutputPacket(
          'potatoes',
          {
            version: 1 as const,
            acquisitionId: prepared.body.acquisitionId,
            requestDigest: prepared.body.requestDigest,
            seller: prepared.body.seller,
            recipient: prepared.body.recipient,
            topic: prepared.body.topic,
            txid: purchase.txid,
            purchaseCommitment,
            assetId: prepared.body.assetId,
            termsDigest: prepared.body.termsDigest,
            releasePolicy: release.policy,
            evidenceDigest: outputPacketDigest('release-evidence', release),
            schema: LCH_OVERLAY_PROFILES.acquisition,
            secret: Utils.toBase64(secret),
            issuedAt: now,
            recoveryUntil: prepared.body.recoveryUntil
          },
          f.sellerKey
        )
      },
      releaseEvidence: release
    }
  }
  let now = '22',
    allowed = true
  const counts = { preparation: 0, purchase: 0, release: 0 },
    selectedChains = selected?.chains ?? chains,
    selectedContext = () => selected?.context ?? bitcoinContext(),
    lineageVerifier = new RevenueListingProfileLineageVerifier(family, selectedChains),
    purchaseVerifier = new RevenueListingProfilePurchaseVerifier(family, selectedChains),
    releaseVerifier = new SDKPrivateReleaseEvidence(selectedChains),
    guard = () => {
      outputAssert(allowed, 'Fixture context changed', 'context-changed')
    },
    options: LCHOverlayCovenantProfileDomainOptions = {
      original: f.input,
      source: { id: 'covenant-fixture-content', read: f.storage.read.bind(f.storage) },
      wallet: f.buyerWallet,
      authorityNetwork: 'testnet',
      revocations: fixtureOptions.revocations,
      maximumCiphertextBytes: 1048576,
      current: () => allowed,
      clock: () => now,
      verification: {
        id: 'full-current-immutable-family-and-retained-local-release',
        preparation: async (packet, request, descriptor, signal) => {
          counts.preparation++
          const packageInput = parseRevenueListingProfileLineagePackage(
              Uint8Array.from(decodeOutputBytes(packet.body.domainEvidence.bytes, 2097152))
            ),
            verified = await lineageVerifier.verify(packageInput, selectedContext(), signal)
          outputAssert(
            verified.status === 'verified' &&
              canonicalOutputJSON(verified.target) === canonicalOutputJSON(request.listing) &&
              canonicalOutputJSON(verified.descriptor) === canonicalOutputJSON(descriptor),
            'Original lineage not independently verified: ' + canonicalOutputJSON(verified)
          )
          guard()
          return {
            stage: verified.stage,
            currentHeight: selectedContext().view.tipHeight,
            checkCurrent: guard
          }
        },
        purchase: async (evidence, selected, signal) => {
          counts.purchase++
          const submitted = await purchaseVerifier.verify(
              selected.candidate,
              selected,
              selectedContext(),
              signal
            ),
            verified = await purchaseVerifier.verify(
              evidence.purchase,
              selected,
              selectedContext(),
              signal
            )
          outputAssert(
            submitted.status === 'verified' &&
              verified.status === 'verified' &&
              submitted.purchaseCommitment === verified.purchaseCommitment,
            'Funded and released subjects differ'
          )
          outputAssert(
            verified.status === 'verified',
            'Purchase not independently verified: ' + canonicalOutputJSON(verified)
          )
          guard()
          return { purchaseCommitment: verified.purchaseCommitment, checkCurrent: guard }
        },
        release: async (evidence, expected, signal) => {
          counts.release++
          return releaseVerifier.verify(
            evidence,
            expected,
            { now, localAcceptedAt: '20', current: () => allowed },
            signal
          )
        }
      }
    },
    domain = await LCHOverlayCovenantProfileDomain.create(options),
    directory = mkdtempSync(join(tmpdir(), 'lch-covenant-native-')),
    path = join(directory, 'buyer.sqlite'),
    configuration = {
      storeId: 'c2'.repeat(32),
      recipient: f.prepare.recipient,
      binding: lchOverlayCustodyBinding(domain.id),
      maximumObjects: 2,
      maximumObjectBytes: 2097152
    },
    codec = new NodeProtectedPayloadCodec(
      { resolve: () => createSecretKey(Buffer.alloc(32, 84)) },
      'disclosed-synthetic'
    ),
    objects = SQLiteProtectedOperationObjectStore.create(path, configuration, codec),
    owners = [objects]
  cleanups.add(async () => {
    await owners.reduce((pending, owner) => pending.then(() => owner.close()), Promise.resolve())
    rmSync(directory, { recursive: true, force: true })
  })
  await domain.initializeCustody(objects)
  function reopen() {
    const owner = SQLiteProtectedOperationObjectStore.open(path, configuration, codec)
    owners.push(owner)
    return owner
  }
  return {
    ...f,
    family,
    lineage,
    genesis,
    active,
    purchased,
    purchaseCommitment,
    terms,
    prepared,
    submission,
    release,
    settlement,
    license,
    domain,
    options,
    objects,
    counts,
    deliver,
    delivered: await deliver(),
    reopen,
    setNow: (value: string) => {
      now = value
    },
    setAccess: (value: boolean) => {
      allowed = value
    },
    purchaseBEEF: () => Beef.fromBinaryStrict(decodeOutputBytes(submission.beef, 2097152))
  }
}
