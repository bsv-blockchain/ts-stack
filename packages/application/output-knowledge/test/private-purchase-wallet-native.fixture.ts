import { createRequire } from 'node:module'
import {
  P2PKH,
  PrivateKey,
  ProtoWallet,
  PublicKey,
  Transaction,
  Utils,
  canonicalOutputJSON,
  outputAssert,
  outputPacketDigest,
  signOutputPacket,
  type OutputPurchasePrepare
} from '@bsv/sdk'
import type { RevenueListingDescriptor } from '@bsv/sdk/script/templates/RevenueListing'
import { revenueListingId } from '@bsv/sdk/script/templates/RevenueListing'
import {
  assembleLineage,
  lineageLimits,
  type RevenueListingLineagePackage
} from '../src/revenue-listing/LineagePackage.js'
import {
  RevenueListingPurchaseVerifier,
  REVENUE_LISTING_LINEAGE_SCHEMA,
  REVENUE_LISTING_PURCHASE_PROFILE
} from '../src/revenue-listing/RevenueListingPurchaseVerifier.js'
import { WalletToolboxPurchasePayment } from '../src/private/WalletToolboxPurchasePayment.js'
import { acquisitionNativeWalletFixture } from './private-acquisition-wallet.fixture.js'
import { chains, completeGenesis, context, family } from './revenue-lineage-fixture.js'
const requireWallet = createRequire(import.meta.url)
const { SQLiteActionRecoveryStore } = requireWallet(
  '@bsv/wallet-toolbox/out/src/storage/actionRecovery/SQLiteActionRecoveryStore'
) as typeof import('@bsv/wallet-toolbox/out/src/storage/actionRecovery/SQLiteActionRecoveryStore')
const { RecoverableActionController } = requireWallet(
  '@bsv/wallet-toolbox/out/src/signer/actionRecovery/RecoverableActionController'
) as typeof import('@bsv/wallet-toolbox/out/src/signer/actionRecovery/RecoverableActionController')
// Extract this fixed, hash-checked public archive once. Each case still owns a
// fresh copy and native wallet; no verification, action or signature is cached.
const publicGenesis = completeGenesis()
/** Actual native wallet, disclosed synthetic mature-chain funding, complete
 * authenticated listing genesis and independently verified resulting purchase.
 * No HTTP/topic/mining/live-customer claim and no broadcast. */
export async function nativePurchaseWalletFixture(
  maximumCandidateBytes = 524288,
  application?: {
    descriptor: RevenueListingDescriptor
    prepare: OutputPurchasePrepare
    sellerKey: PrivateKey
    buyerKeyCode: number
    now: number
  }
) {
  const original = structuredClone(publicGenesis),
    assembly = assembleLineage(original, lineageLimits({})),
    anchor = assembly.beef.findAtomicTransaction(original.descriptor.lineageAnchor.txid)!,
    descriptor = structuredClone(application?.descriptor ?? original.descriptor)
  descriptor.chain.network = 'mock'
  descriptor.lineageAnchor.chain.network = 'mock'
  const view = context()
  view.view.chain = descriptor.chain
  const selected = { ...descriptor.chain, network: 'mock' as const },
    resolved = await chains.resolve(view.view, new AbortController().signal),
    native = await acquisitionNativeWalletFixture(
      selected,
      resolved.tracker,
      application?.buyerKeyCode ?? 44,
      {
        maxOutputsPerAction: 1,
        migrationInputsPerAction: 0
      }
    ),
    sender = new ProtoWallet(new PrivateKey(90)),
    senderIdentityKey = (await sender.getPublicKey({ identityKey: true })).publicKey,
    derivationPrefix = 'bmF0aXZlLWNvdmVuYW50',
    derivationSuffix = 'cHVibGljLWZpeHR1cmU=',
    fundingKey = (
      await sender.getPublicKey({
        protocolID: [2, '3241645161d8'],
        keyID: `${derivationPrefix} ${derivationSuffix}`,
        counterparty: native.native.identities.wallet
      })
    ).publicKey,
    amount = anchor.outputs[descriptor.lineageAnchor.outputIndex].satoshis!,
    genesis = new Transaction(
      1,
      [
        {
          sourceTransaction: anchor,
          sourceOutputIndex: descriptor.lineageAnchor.outputIndex,
          sequence: 0xffffffff,
          unlockingScriptTemplate: new P2PKH().unlock(new PrivateKey(41))
        }
      ],
      [
        { satoshis: Number(descriptor.reserve), lockingScript: family.lock(descriptor) },
        {
          satoshis: amount - Number(descriptor.reserve) - 1,
          lockingScript: new P2PKH().lock(PublicKey.fromString(fundingKey).toAddress())
        }
      ],
      0
    )
  await genesis.sign()
  await native.native.wallet.internalizeAction({
    tx: genesis.toAtomicBEEF(),
    outputs: [
      {
        outputIndex: 1,
        protocol: 'wallet payment',
        paymentRemittance: { senderIdentityKey, derivationPrefix, derivationSuffix }
      }
    ],
    description: 'Disclosed synthetic covenant funding'
  })
  const point = { chain: selected, txid: genesis.id('hex'), outputIndex: 0 },
    sellerKey = application?.sellerKey ?? new PrivateKey(41),
    lineage: RevenueListingLineagePackage = {
      version: 1,
      descriptor,
      genesis: signOutputPacket(
        'sale-genesis',
        { version: 1 as const, listingId: revenueListingId(descriptor), genesis: point },
        sellerKey
      ),
      target: point,
      transactions: [{ txid: point.txid, beef: Utils.toBase64(genesis.toAtomicBEEF()) }]
    },
    prepare: OutputPurchasePrepare = application
      ? { ...structuredClone(application.prepare), listing: point }
      : {
          version: 1,
          requestId: 'native-covenant-purchase',
          topic: 'tm_native_purchase',
          listing: point,
          assetId: descriptor.assetId,
          termsDigest: descriptor.termsDigest,
          recipient: native.native.identities.wallet,
          request: 'AA=='
        },
    terms = signOutputPacket(
      'purchase-terms',
      {
        version: 1 as const,
        acquisitionId: outputPacketDigest('purchase', {
          chain: selected,
          seller: descriptor.seller,
          recipient: prepare.recipient,
          topic: prepare.topic,
          requestId: prepare.requestId
        }),
        requestDigest: outputPacketDigest('purchase-request', prepare),
        seller: descriptor.seller,
        recipient: prepare.recipient,
        topic: prepare.topic,
        listing: point,
        assetId: prepare.assetId,
        termsDigest: prepare.termsDigest,
        domainProfile: REVENUE_LISTING_PURCHASE_PROFILE,
        domainEvidence: {
          schema: REVENUE_LISTING_LINEAGE_SCHEMA,
          bytes: Utils.toBase64(
            new TextEncoder().encode(canonicalOutputJSON(lineage, { bytes: 4194304 }))
          )
        },
        releasePolicy: { kind: 'local-admission' as const },
        purchaseUntil: application ? String(application.now + 80) : '100',
        recoveryUntil: application ? String(application.now + 172880) : '86500'
      },
      sellerKey
    ),
    counts = { prepare: 0, recover: 0, finalize: 0 }
  outputAssert(
    prepare.recipient === native.native.identities.wallet &&
      prepare.assetId === descriptor.assetId &&
      prepare.termsDigest === descriptor.termsDigest &&
      descriptor.seller === sellerKey.toPublicKey().toString(),
    'Native application fixture differs from the installed buyer/seller/asset'
  )
  let allowed = true,
    lose = false
  async function open(owner = native.native, create = false) {
    const store = await SQLiteActionRecoveryStore[create ? 'install' : 'open'](owner.active),
      controller = new RecoverableActionController(owner.wallet, store, 'native-covenant.local'),
      actions = {
        configuration: () => controller.configuration(),
        prepare: (...args: Parameters<typeof controller.prepare>) => {
          counts.prepare++
          return controller.prepare(...args)
        },
        recover: (...args: Parameters<typeof controller.recover>) => {
          counts.recover++
          return controller.recover(...args)
        },
        finalize: async (...args: Parameters<typeof controller.finalize>) => {
          counts.finalize++
          const result = await controller.finalize(...args)
          if (lose) {
            lose = false
            throw new Error('Lost native finalization reply')
          }
          return result
        }
      },
      paymentOptions = {
        actions,
        family,
        chains,
        verificationId: 'urn:test:actual-native-purchase',
        context: () => {
          const current = context()
          current.view.chain = selected
          return current
        },
        checkCurrent: () => {
          outputAssert(allowed, 'Selected native purchase context changed', 'context-changed')
        },
        binding: {
          wallet: owner.identities.wallet,
          storage: owner.identities.storage,
          chain: selected,
          originator: 'native-covenant.local',
          seller: descriptor.seller
        },
        maximumCandidateBytes
      },
      payment = new WalletToolboxPurchasePayment(paymentOptions)
    return { owner, controller, actions, paymentOptions, payment }
  }
  const installed = await open(native.native, true),
    verifier = new RevenueListingPurchaseVerifier(family, chains)
  return {
    ...installed,
    native,
    prepare,
    terms,
    counts,
    lineage,
    selected,
    async reopen() {
      return open(await native.open())
    },
    async verify(candidate: { txid: string; beef: string }) {
      const current = context()
      current.view.chain = selected
      const result = await verifier.verify(
        { txid: candidate.txid, beef: candidate.beef, outputIndex: 0 },
        { request: prepare, terms, seller: descriptor.seller },
        current
      )
      return result
    },
    setAccess: (value: boolean) => {
      allowed = value
    },
    loseFinalization: () => {
      lose = true
    },
    close: native.close
  }
}
