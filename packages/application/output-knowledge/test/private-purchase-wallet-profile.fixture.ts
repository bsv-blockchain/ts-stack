import { createRequire } from 'node:module'
import {
  Beef,
  BigNumber,
  KeyDeriver,
  TransactionSignature,
  P2PKH,
  Hash,
  MerklePath,
  LockingScript,
  UnlockingScript,
  PrivateKey,
  ProtoWallet,
  PublicKey,
  Transaction,
  Utils,
  canonicalOutputJSON,
  outputAssert,
  outputPacketDigest,
  outputHex32,
  parseOutputPurchasePrepare,
  signOutputPacket,
  type OutputPurchasePrepare,
  type OutputReleasePolicy,
  parseOutputReleasePolicy,
  type OutputPurchaseSubmit
} from '@bsv/sdk'
import type { RevenueListingProfileAuthority } from '../src/revenue-listing/RevenueListingProfileAuthority.js'
import type { ChainTracker } from '@bsv/sdk'
import { RevenueListingProfileSpend } from '@bsv/sdk/script/templates/RevenueListingProfileSpend'
import { revenueListingPurchaseCommitment } from '@bsv/sdk/script/templates/RevenueListingSpend'
import {
  parseRevenueListingProfileDescriptor,
  type RevenueListingProfileDescriptor
} from '@bsv/sdk/script/templates/RevenueListingProfile'
import { assembleLineage, lineageLimits } from '../src/revenue-listing/LineagePackage.js'
import {
  REVENUE_LISTING_LINEAGE_SCHEMA,
  REVENUE_LISTING_PURCHASE_PROFILE
} from '../src/revenue-listing/RevenueListingPurchaseVerifier.js'
import { WalletToolboxProfilePurchasePayment } from '../src/private/WalletToolboxProfilePurchasePayment.js'
import { RevenueListingProfilePurchaseVerifier } from '../src/revenue-listing/RevenueListingProfilePurchaseVerifier.js'
import type { RevenueListingProfileLineagePackage } from '../src/revenue-listing/ProfileLineagePackage.js'
import type { ChainViewResolver } from '../src/SDKEvidenceVerifier.js'
import { acquisitionNativeWalletFixture } from './private-acquisition-wallet.fixture.js'
import { atGenesis, context, profile, fixture } from './revenue-profile.fixture.js'
const requireWallet = createRequire(import.meta.url)
const { SQLiteActionRecoveryStore } = requireWallet(
  '@bsv/wallet-toolbox/out/src/storage/actionRecovery/SQLiteActionRecoveryStore'
) as typeof import('@bsv/wallet-toolbox/out/src/storage/actionRecovery/SQLiteActionRecoveryStore')
const { RecoverableActionController } = requireWallet(
  '@bsv/wallet-toolbox/out/src/signer/actionRecovery/RecoverableActionController'
) as typeof import('@bsv/wallet-toolbox/out/src/signer/actionRecovery/RecoverableActionController')
// Extract this fixed, hash-checked public archive once. Each case still owns a
// fresh copy and native wallet; no verification, action or signature is cached.
const publicGenesis = atGenesis()
/** Disclosed independent easy-work funding checkpoint. The normative corpus's
 * checkpoint belongs to the seller root; a current integration must not sign that
 * root. This fresh checkpoint pays only the unrelated public funding actor. */
function nativeFundingChain(originalAnchor: Transaction, maximumHeight = 101) {
  outputAssert(
    Number.isSafeInteger(maximumHeight) && maximumHeight >= 101 && maximumHeight <= 4096,
    'Invalid synthetic native header bound'
  )
  let selectedHeight = 101
  const anchor = new Transaction(
    originalAnchor.version,
    originalAnchor.inputs.map(input => ({ ...input })),
    [
      {
        satoshis: 1000000,
        lockingScript: new P2PKH().lock(
          new PrivateKey(fixture.testActors.funding.scalar).toPublicKey().toAddress()
        )
      }
    ],
    originalAnchor.lockTime
  )
  anchor.merklePath = new MerklePath(0, [[{ offset: 0, hash: anchor.id('hex'), txid: true }]])
  const headers: { height: number; raw: string; hash: string; merkleRoot: string }[] = []
  let purchaseRoot: string | undefined
  function rebuildHeaders() {
    headers.length = 0
    for (let height = 0; height <= maximumHeight; height++) {
      const bytes = Uint8Array.from(Utils.toArray(fixture.headers[0].raw, 'hex'))
      const data = new DataView(bytes.buffer)
      const root =
        height === 0
          ? anchor.id('hex')
          : height === 102 && purchaseRoot !== undefined
            ? purchaseRoot
            : Utils.toHex(Hash.sha256(Utils.toArray(`native-current-header-${height}`, 'utf8')))
      bytes.set(Utils.toArray(headers.at(-1)?.hash ?? '00'.repeat(32), 'hex').reverse(), 4)
      bytes.set(Utils.toArray(root, 'hex').reverse(), 36)
      data.setUint32(68, data.getUint32(68, true) + height * 600, true)
      let hash = '',
        nonce = 0
      do {
        data.setUint32(76, nonce++, true)
        hash = Utils.toHex(Hash.hash256(Array.from(bytes)).reverse())
      } while (BigInt('0x' + hash) > 0x7fffffn << 232n)
      headers.push({ height, raw: Utils.toHex(Array.from(bytes)), hash, merkleRoot: root })
    }
  }
  rebuildHeaders()
  const chain = { network: 'mock' as const, genesisHash: headers[0].hash }
  const chains: ChainViewResolver = {
    resolve: (view: ReturnType<typeof context>['view']) => {
      const tip = Number(view.tipHeight)
      outputAssert(
        Number.isSafeInteger(tip) && tip >= 101 && tip <= maximumHeight,
        'Missing selected synthetic native view',
        'context-changed'
      )
      outputAssert(
        canonicalOutputJSON(view) === canonicalOutputJSON(currentContext(tip).view),
        'Selected synthetic native view changed',
        'context-changed'
      )
      return Promise.resolve({
        view: structuredClone(view),
        tracker: {
          currentHeight: () => Promise.resolve(tip),
          isValidRootForHeight: (root: string, height: number) =>
            Promise.resolve(height <= tip && headers[height]?.merkleRoot === root)
        },
        header: (height: number) => {
          const header = height <= tip ? headers[height] : undefined
          return header
            ? Promise.resolve(header)
            : Promise.reject(new Error('Missing synthetic native header'))
        }
      })
    }
  }
  const currentContext = (height = selectedHeight) => {
    outputAssert(headers[height] !== undefined, 'Missing selected synthetic native header')
    const current = context()
    if (maximumHeight > 101) {
      current.id = 'native-current-context-' + height
      current.view.id = 'native-current-view-' + height
    }
    current.view.chain = structuredClone(chain)
    current.view.tipHash = headers[height].hash
    current.view.tipHeight = String(height)
    current.view.medianTimePast = String(
      new DataView(Uint8Array.from(Utils.toArray(headers[height - 5].raw, 'hex')).buffer).getUint32(
        68,
        true
      )
    )
    return current
  }
  return {
    anchor,
    chains,
    chain,
    currentContext,
    selectPurchaseProof: (txid?: string) => {
      outputAssert(maximumHeight >= 102, 'Synthetic proof extension was not installed')
      const proof =
        txid === undefined
          ? undefined
          : new MerklePath(102, [
              [
                { offset: 0, hash: '01'.repeat(32) },
                { offset: 1, hash: outputHex32(txid), txid: true }
              ]
            ])
      purchaseRoot = proof?.computeRoot()
      rebuildHeaders()
      selectedHeight = 102
      return proof
    },
    setVerifiedHeight: (height: number) => {
      outputAssert(
        headers[height] !== undefined && height >= 101,
        'Missing selected synthetic native header'
      )
      selectedHeight = height
    }
  }
}

/** Actual native wallet, disclosed synthetic mature-chain funding, complete
 * authenticated listing genesis and independently verified resulting purchase.
 * No HTTP/topic/mining/live-customer claim and no broadcast. */
export interface NativeProfilePurchaseOptions {
  revenue?: typeof fixture.descriptor.initialRevenue
  purchasePrice?: string
  genesisFeeSatoshis?: number
  maximumVerifiedHeight?: number
  actionBatchMode?: 'auto' | 'legacy'
  /** Construct a neutral application listing against this disclosed funding
   * checkpoint before any wallet preparation. Omission preserves the original
   * route fixture; the application cannot replace the selected chain/anchor. */
  application?: (funding: {
    chain: { network: 'mock'; genesisHash: string }
    anchor: { chain: { network: 'mock'; genesisHash: string }; txid: string; outputIndex: number }
  }) => Promise<{
    descriptor: RevenueListingProfileDescriptor
    prepare: OutputPurchasePrepare
    sellerKey: PrivateKey
    buyerKeyCode: number
    now: number
    releasePolicy?: OutputReleasePolicy
  }>
  prepareGenesisAuthority?: (dependencies: {
    descriptor: typeof fixture.descriptor
    chain: { network: 'mock'; genesisHash: string }
    tracker: ChainTracker
  }) => Promise<RevenueListingProfileAuthority>
}

export async function nativeProfilePurchaseWalletFixture(
  maximumCandidateBytes = 524288,
  expiryHeight = fixture.descriptor.expiryHeight,
  options: NativeProfilePurchaseOptions = {}
) {
  const original = structuredClone(publicGenesis),
    assembly = assembleLineage(original, lineageLimits({})),
    funding = nativeFundingChain(
      assembly.beef.findAtomicTransaction(original.descriptor.lineageAnchor.txid)!,
      options.maximumVerifiedHeight ?? 101
    ),
    { anchor, chains, currentContext } = funding,
    application = await options.application?.({
      chain: structuredClone(funding.chain),
      anchor: { chain: structuredClone(funding.chain), txid: anchor.id('hex'), outputIndex: 0 }
    }),
    descriptor = structuredClone(application?.descriptor ?? original.descriptor)
  if (application !== undefined) {
    outputAssert(
      options.revenue === undefined &&
        options.purchasePrice === undefined &&
        application.descriptor.expiryHeight === expiryHeight &&
        canonicalOutputJSON(application.descriptor.chain) === canonicalOutputJSON(funding.chain) &&
        canonicalOutputJSON(application.descriptor.lineageAnchor) ===
          canonicalOutputJSON({
            chain: funding.chain,
            txid: anchor.id('hex'),
            outputIndex: 0
          }) &&
        Number.isSafeInteger(application.now) &&
        application.now >= 0 &&
        Number.isSafeInteger(application.buyerKeyCode) &&
        application.buyerKeyCode > 0,
      'Application original must bind the selected synthetic funding and immutable schedule'
    )
    const ownedDescriptor = parseRevenueListingProfileDescriptor(application.descriptor),
      ownedRequest = parseOutputPurchasePrepare(application.prepare)
    outputAssert(
      ownedDescriptor.seller === application.sellerKey.toPublicKey().toString() &&
        ownedRequest.assetId === ownedDescriptor.assetId &&
        ownedRequest.termsDigest === ownedDescriptor.termsDigest &&
        ownedRequest.recipient ===
          new PrivateKey(application.buyerKeyCode).toPublicKey().toString() &&
        canonicalOutputJSON(ownedRequest.listing.chain) === canonicalOutputJSON(funding.chain),
      'Application original buyer, seller, asset, terms and chain must match before wallet funding'
    )
  }
  descriptor.expiryHeight = expiryHeight
  if (options.purchasePrice !== undefined) descriptor.purchasePrice = options.purchasePrice
  if (options.revenue !== undefined) descriptor.initialRevenue = structuredClone(options.revenue)
  descriptor.chain = structuredClone(funding.chain)
  descriptor.lineageAnchor = {
    chain: structuredClone(funding.chain),
    txid: anchor.id('hex'),
    outputIndex: 0
  }
  const view = currentContext()
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
      },
      options.actionBatchMode
    ),
    genesisAuthority =
      options.prepareGenesisAuthority === undefined
        ? undefined
        : await options.prepareGenesisAuthority({
            descriptor: structuredClone(descriptor),
            chain: selected,
            tracker: resolved.tracker
          }),
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
          unlockingScriptTemplate: new P2PKH().unlock(
            new PrivateKey(fixture.testActors.funding.scalar)
          )
        }
      ],
      [
        {
          satoshis: Number(descriptor.reserve),
          lockingScript: profile.lock('activation', descriptor)
        },
        {
          satoshis: 200000,
          lockingScript: new P2PKH().lock(
            new PrivateKey(fixture.testActors.funding.scalar).toPublicKey().toAddress()
          )
        },
        {
          satoshis:
            amount - Number(descriptor.reserve) - 200000 - (options.genesisFeeSatoshis ?? 1),
          lockingScript: new P2PKH().lock(PublicKey.fromString(fundingKey).toAddress())
        }
      ],
      0
    )
  outputAssert(
    options.genesisFeeSatoshis === undefined ||
      (Number.isSafeInteger(options.genesisFeeSatoshis) &&
        options.genesisFeeSatoshis > 0 &&
        options.genesisFeeSatoshis < 100000),
    'Invalid synthetic genesis fee'
  )
  await genesis.sign()
  // Public activation spends the reserve listing and separate synthetic funding.
  // Seller identity root never signs either transaction. No derived private key
  // leaves a wallet API; the disclosed funding actor is unrelated to sale authority.
  const activation = new RevenueListingProfileSpend(
    profile,
    descriptor,
    [{ rawTransaction: genesis.toHex(), outputIndex: 0 }],
    { operation: 'activate' }
  )
  const activationPlan = activation.plan()
  const unsigned = new Transaction(
    1,
    [
      {
        sourceTransaction: genesis,
        sourceTXID: genesis.id('hex'),
        sourceOutputIndex: 0,
        sequence: 0xffffffff,
        unlockingScript: new UnlockingScript()
      },
      {
        sourceTransaction: genesis,
        sourceTXID: genesis.id('hex'),
        sourceOutputIndex: 1,
        sequence: 0xffffffff,
        unlockingScript: new UnlockingScript()
      }
    ],
    [
      ...activationPlan.outputs.map(output => ({
        satoshis: Number(output.satoshis),
        lockingScript: LockingScript.fromHex(output.lockingScript)
      })),
      { satoshis: 199990, lockingScript: genesis.outputs[1].lockingScript }
    ],
    0
  )
  const preparedActivation = activation.prepare(unsigned)
  outputAssert(
    preparedActivation.signingRequests().length === 0,
    'Activation cannot request a seller-root signature'
  )
  const active = preparedActivation.complete({})
  active.inputs[1].unlockingScript = await new P2PKH()
    .unlock(new PrivateKey(fixture.testActors.funding.scalar))
    .sign(active, 1)
  preparedActivation.assertFinalLayout(active)
  await native.native.wallet.internalizeAction({
    tx: genesis.toAtomicBEEF(),
    outputs: [
      {
        outputIndex: 2,
        protocol: 'wallet payment',
        paymentRemittance: { senderIdentityKey, derivationPrefix, derivationSuffix }
      }
    ],
    description: 'Disclosed synthetic current-profile purchase funding'
  })
  const point = { chain: selected, txid: genesis.id('hex'), outputIndex: 0 },
    sellerKey = application?.sellerKey ?? new PrivateKey(fixture.testActors.seller.scalar),
    lineage: RevenueListingProfileLineagePackage = {
      version: 1,
      descriptor,
      genesis:
        genesisAuthority === undefined
          ? signOutputPacket(
              'sale-genesis',
              {
                version: 1 as const,
                listingId: outputPacketDigest('sale-listing', descriptor),
                genesis: point
              },
              sellerKey
            )
          : await genesisAuthority.signGenesis(descriptor, point),
      target: { ...point, txid: active.id('hex') },
      transactions: [
        { txid: point.txid, beef: Utils.toBase64(genesis.toAtomicBEEF()) },
        { txid: active.id('hex'), beef: Utils.toBase64(active.toAtomicBEEF()) }
      ].sort((a, b) => a.txid.localeCompare(b.txid))
    },
    prepare: OutputPurchasePrepare =
      application === undefined
        ? {
            version: 1,
            requestId: 'native-current-profile-purchase',
            topic: 'tm_native_current_purchase',
            listing: structuredClone(lineage.target),
            assetId: descriptor.assetId,
            termsDigest: descriptor.termsDigest,
            recipient: native.native.identities.wallet,
            request: 'AA=='
          }
        : { ...structuredClone(application.prepare), listing: structuredClone(lineage.target) },
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
        listing: structuredClone(lineage.target),
        assetId: prepare.assetId,
        termsDigest: prepare.termsDigest,
        domainProfile: REVENUE_LISTING_PURCHASE_PROFILE,
        domainEvidence: {
          schema: REVENUE_LISTING_LINEAGE_SCHEMA,
          bytes: Utils.toBase64(
            new TextEncoder().encode(canonicalOutputJSON(lineage, { bytes: 4194304 }))
          )
        },
        releasePolicy: parseOutputReleasePolicy(
          application?.releasePolicy ?? { kind: 'local-admission' }
        ),
        purchaseUntil: String((application?.now ?? Math.floor(Date.now() / 1000)) + 80),
        recoveryUntil: String((application?.now ?? Math.floor(Date.now() / 1000)) + 172880)
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
    lose = false,
    height = 101
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
        family: profile,
        chains,
        verificationId: 'urn:test:actual-native-purchase',
        context: () => {
          const current = currentContext()
          current.view.chain = selected
          current.view.tipHeight = String(height)
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
      payment = new WalletToolboxProfilePurchasePayment(paymentOptions)
    return { owner, controller, actions, paymentOptions, payment }
  }
  const installed = await open(native.native, true),
    verifier = new RevenueListingProfilePurchaseVerifier(profile, chains)
  return {
    ...installed,
    native,
    prepare,
    terms,
    counts,
    lineage,
    selected,
    chains,
    currentContext,
    setVerifiedHeight: (value: number) => {
      funding.setVerifiedHeight(value)
      height = value
    },
    async reopen() {
      return open(await native.open())
    },
    /** Public synthetic fixture keys only. A distinct valid funding-input
     * signature gives a second txid with the SAME full listing-input preimage.
     * The fixed nonce belongs exclusively to this disclosed test key; it must
     * never be used by a production signer. No second wallet action is made. */
    async alternativeCandidate(candidate: OutputPurchaseSubmit): Promise<OutputPurchaseSubmit> {
      const original = Beef.fromBinaryStrict(Utils.toArray(candidate.beef, 'base64')),
        originalTx = original.findTransactionForSigning(candidate.txid)!,
        changed = Transaction.fromHex(originalTx.toHex()),
        publicKey = new KeyDeriver(
          new PrivateKey(application?.buyerKeyCode ?? 44)
        ).derivePrivateKey(
          [2, '3241645161d8'],
          `${derivationPrefix} ${derivationSuffix}`,
          senderIdentityKey
        )
      for (let index = 0; index < changed.inputs.length; index++)
        changed.inputs[index].sourceTransaction = originalTx.inputs[index].sourceTransaction
      const index = changed.inputs.findIndex(
        (input, position) =>
          position > 0 && input.sourceTXID === genesis.id('hex') && input.sourceOutputIndex === 2
      )
      outputAssert(index >= 1, 'Expected disclosed native funding input')
      const input = changed.inputs[index],
        prior = input.sourceTransaction!.outputs[input.sourceOutputIndex]
      outputAssert(
        prior.lockingScript.toHex() ===
          new P2PKH().lock(publicKey.toPublicKey().toAddress()).toHex(),
        'Disclosed fixture key does not own selected funding output'
      )
      const scope = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID,
        preimage = TransactionSignature.format({
          sourceTXID: input.sourceTXID!,
          sourceOutputIndex: input.sourceOutputIndex,
          sourceSatoshis: prior.satoshis!,
          transactionVersion: changed.version,
          otherInputs: changed.inputs.filter((_, position) => position !== index),
          outputs: changed.outputs,
          inputIndex: index,
          subscript: prior.lockingScript,
          inputSequence: input.sequence!,
          lockTime: changed.lockTime,
          scope
        }),
        signature = publicKey.sign(Hash.sha256(preimage), undefined, true, new BigNumber(2)),
        bytes = new TransactionSignature(signature.r, signature.s, scope).toChecksigFormat(),
        key = publicKey.toPublicKey().encode(true) as number[]
      input.unlockingScript = new UnlockingScript([
        { op: bytes.length, data: bytes },
        { op: key.length, data: key }
      ])
      outputAssert(
        changed.id('hex') !== candidate.txid &&
          revenueListingPurchaseCommitment(changed) ===
            revenueListingPurchaseCommitment(originalTx),
        'Alternative must change only raw identity, not the complete economic commitment'
      )
      const selected = await chains.resolve(currentContext().view, new AbortController().signal)
      outputAssert(
        await changed.verify(selected.tracker),
        'Alternative synthetic Script verification failed'
      )
      const complete = new Beef()
      complete.mergeTransaction(changed)
      return {
        ...candidate,
        txid: changed.id('hex'),
        beef: Utils.toBase64(complete.toBinaryAtomic(changed.id('hex')))
      }
    },
    /** Commit a synthetic checked header tree at non-coinbase position1. This
     * proves Script/SPV against fixture ancestry, never a production block body. */
    proveCandidate(candidate: OutputPurchaseSubmit): OutputPurchaseSubmit {
      const proof = funding.selectPurchaseProof(candidate.txid)!,
        complete = Beef.fromBinaryStrict(Utils.toArray(candidate.beef, 'base64')),
        raw = complete.findTransactionForSigning(candidate.txid)!.toBinary(),
        index = complete.mergeBump(proof)
      complete.mergeRawTx(raw, index)
      height = 102
      return { ...candidate, beef: Utils.toBase64(complete.toBinaryAtomic(candidate.txid)) }
    },
    regressProof() {
      funding.selectPurchaseProof()
      height = 102
    },
    async verify(candidate: { txid: string; beef: string }) {
      const current = currentContext()
      current.view.chain = selected
      const result = await verifier.verify(
        { txid: candidate.txid, beef: candidate.beef, outputIndex: 0 },
        { request: prepare, terms, seller: descriptor.seller },
        current
      )
      return result
    },
    setHeight: (value: number) => {
      height = value
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
