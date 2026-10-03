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
import { revenueListingId } from '@bsv/sdk/script/templates/RevenueListing'
import { RevenueListingSpend } from '@bsv/sdk/script/templates/RevenueListingSpend'
import { afterEach } from '@jest/globals'
import { createSecretKey } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQLiteProtectedOperationObjectStore } from '../../../application/output-knowledge/src/operations/SQLiteProtectedOperationObjectStore.js'
import { NodeProtectedPayloadCodec } from '../../../application/output-knowledge/src/private/NodeProtectedPayloadCodec.js'
import { SDKPrivateReleaseEvidence } from '../../../application/output-knowledge/src/private/SDKPrivateReleaseEvidence.js'
import { RevenueListingLineageVerifier } from '../../../application/output-knowledge/src/revenue-listing/RevenueListingLineageVerifier.js'
import { RevenueListingPurchaseVerifier } from '../../../application/output-knowledge/src/revenue-listing/RevenueListingPurchaseVerifier.js'
import {
  assembleLineage,
  lineageLimits,
  parseRevenueListingLineagePackage,
  type RevenueListingLineagePackage
} from '../../../application/output-knowledge/src/revenue-listing/LineagePackage.js'
import {
  chains,
  completeGenesis,
  context as bitcoinContext,
  family
} from '../../../application/output-knowledge/test/revenue-lineage-fixture.js'
import { lchCovenantFixture } from './overlay-acquisition-covenant.fixture.js'
import { WalletBRC78KeyDelivery, type KeyGrant, type SignedObject } from '../src/index.js'
import { createLCHOverlayFixedRenderAgreement } from '../src/overlayAcquisitionPolicy.js'
import { LCH_OVERLAY_PROFILES, encodeLCHOverlayContext } from '../src/overlayAcquisitionCodec.js'
import { validateLCHOverlayCovenantTerms } from '../src/overlayAcquisitionCovenantTerms.js'
import {
  LCHOverlayCovenantDomain,
  type LCHOverlayCovenantDomainOptions
} from '../src/overlayAcquisitionCovenant.js'
import { lchOverlayCustodyBinding } from '../src/overlayAcquisitionCustody.js'

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const close of cleanups) await close()
  cleanups.clear()
})

/** Full disclosed synthetic Bitcoin/genesis/covenant and actual encrypted
 * native buyer custody. Funding is constructed from public fixture keys, not a
 * wallet action; topical admission, live chain outcome and wallet integration
 * are separate demonstrations. No broadcast, mainnet evidence or customer keys.
 */
export async function lchNativeCovenantFixture(
  fixtureOptions: {
    detached?: boolean
    revocations?: LCHOverlayCovenantDomainOptions['revocations']
  } = {}
) {
  const original = completeGenesis(),
    assembly = assembleLineage(original, lineageLimits({})),
    anchor = assembly.beef.findAtomicTransaction(original.descriptor.lineageAnchor.txid)!,
    f = await lchCovenantFixture({
      chain: original.descriptor.chain,
      anchor: original.descriptor.lineageAnchor,
      embedCiphertext: fixtureOptions.detached !== true
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
        { satoshis: Number(f.descriptor.reserve), lockingScript: family.lock(f.descriptor) },
        { satoshis: 5000, lockingScript: new P2PKH().lock(f.buyerKey.toPublicKey().toAddress()) },
        {
          satoshis: total - 5001 - Number(f.descriptor.reserve),
          lockingScript: new P2PKH().lock(new PrivateKey(41).toPublicKey().toAddress())
        }
      ],
      0
    )
  await genesis.sign()
  const point = { chain: original.descriptor.chain, txid: genesis.id('hex'), outputIndex: 0 },
    lineage: RevenueListingLineagePackage = {
      version: 1,
      descriptor: f.descriptor,
      genesis: signOutputPacket(
        'sale-genesis',
        { version: 1 as const, listingId: revenueListingId(f.descriptor), genesis: point },
        f.sellerKey
      ),
      target: point,
      transactions: [{ txid: point.txid, beef: Utils.toBase64(genesis.toAtomicBEEF()) }]
    }
  f.prepare.listing = point
  const json = (value: unknown) => new TextEncoder().encode(canonicalOutputJSON(value)),
    prepared = f.signedTerms({
      domainEvidence: {
        schema: 'https://bsv.brc.dev/tokens/0197#lineage-package-v1',
        bytes: Utils.toBase64(json(lineage))
      }
    }),
    spend = new RevenueListingSpend(
      family,
      f.descriptor,
      [{ rawTransaction: genesis.toHex(), outputIndex: 0 }],
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
        ...plan.outputs.map(output => ({
          satoshis: Number(output.satoshis),
          lockingScript: LockingScript.fromHex(output.lockingScript)
        })),
        { satoshis: 4800, lockingScript: new P2PKH().lock(f.buyerKey.toPublicKey().toAddress()) }
      ],
      0
    ),
    purchased = spend.prepare(funded).complete([{ recipients: [] }])
  purchased.inputs[0].sourceTransaction = genesis
  purchased.inputs[1].sourceTransaction = genesis
  purchased.inputs[1].unlockingScriptTemplate = new P2PKH().unlock(f.buyerKey)
  await purchased.sign()
  const purchase = {
      txid: purchased.id('hex'),
      outputIndex: 0,
      beef: Utils.toBase64(purchased.toAtomicBEEF())
    },
    submission: OutputPurchaseSubmit = {
      version: 1,
      acquisitionId: prepared.body.acquisitionId,
      txid: purchase.txid,
      beef: purchase.beef
    },
    release: OutputReleaseEvidence = {
      chain: point.chain,
      txid: purchase.txid,
      policy: { kind: 'local-admission' },
      acceptedAt: '20'
    },
    terms = await validateLCHOverlayCovenantTerms(f.input),
    settlementBody = {
      version: 1 as const,
      seller: f.descriptor.seller,
      buyer: f.prepare.recipient,
      requestId: f.prepare.requestId,
      offerId: f.prepare.termsDigest,
      assetId: f.prepare.assetId,
      dutyUid: terms.policy.dutyUid,
      acquisitionId: prepared.body.acquisitionId,
      listingId: revenueListingId(f.descriptor),
      previous: point,
      successor: { ...point, txid: purchase.txid },
      txid: purchase.txid,
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
  for (const [key, cek] of f.asset.keys) {
    const keyId = Uint8Array.from(Utils.toArray(key, 'hex'))
    keyGrants.push({
      keyId,
      delivery: 'https://bsv.brc.dev/apps/0170#brc78-key-v1',
      payload: await sender.deliver(f.prepare.recipient, keyId, cek)
    })
  }
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
    lineageVerifier = new RevenueListingLineageVerifier(family, chains),
    purchaseVerifier = new RevenueListingPurchaseVerifier(family, chains),
    releaseVerifier = new SDKPrivateReleaseEvidence(chains),
    guard = () => {
      outputAssert(allowed, 'Fixture context changed', 'context-changed')
    },
    options: LCHOverlayCovenantDomainOptions = {
      original: f.input,
      source: { id: 'covenant-fixture-content', read: f.storage.read.bind(f.storage) },
      wallet: f.buyerWallet,
      authorityNetwork: 'testnet',
      revocations: fixtureOptions.revocations,
      maximumCiphertextBytes: 1048576,
      current: () => allowed,
      clock: () => now,
      verification: {
        id: 'full-synthetic-family-and-retained-local-release',
        preparation: async (packet, request, descriptor, signal) => {
          counts.preparation++
          const packageInput = parseRevenueListingLineagePackage(
              Uint8Array.from(decodeOutputBytes(packet.body.domainEvidence.bytes, 2097152))
            ),
            verified = await lineageVerifier.verify(packageInput, bitcoinContext(), signal)
          outputAssert(
            verified.status === 'verified' &&
              canonicalOutputJSON(verified.target) === canonicalOutputJSON(request.listing) &&
              canonicalOutputJSON(verified.descriptor) === canonicalOutputJSON(descriptor),
            'Original lineage not independently verified: ' + canonicalOutputJSON(verified)
          )
          guard()
          return { checkCurrent: guard }
        },
        purchase: async (evidence, selected, signal) => {
          counts.purchase++
          const verified = await purchaseVerifier.verify(
            evidence.purchase,
            selected,
            bitcoinContext(),
            signal
          )
          outputAssert(
            verified.status === 'verified',
            'Purchase not independently verified: ' + canonicalOutputJSON(verified)
          )
          guard()
          return { checkCurrent: guard }
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
    domain = await LCHOverlayCovenantDomain.create(options),
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
    for (const owner of owners) await owner.close()
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
    purchased,
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
