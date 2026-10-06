import {
  PrivatePurchaseBuyer,
  privatePurchaseBuyerBinding,
  PRIVATE_PURCHASE_BUYER_INITIAL,
  type PrivatePurchaseBuyerOptions
} from '../../../../application/output-knowledge/src/private/PrivatePurchaseBuyer.js'
import {
  ProtectedOperationStateStore,
  protectedOperationBinding,
  PROTECTED_OPERATION_INITIAL
} from '../../../../application/output-knowledge/src/operations/ProtectedOperationStateStore.js'
import { SQLiteOperationStateStore } from '../../../../application/output-knowledge/src/operations/SQLiteOperationStateStore.js'
import { custody as fixtureCustody } from '../../../../application/output-knowledge/test/protected-operation-object.fixture.js'
import { afterEach } from '@jest/globals'
import express from 'express'
import { createServer } from 'node:http'
import { createSecretKey, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import {
  CompletedProtoWallet,
  outputAssert,
  canonicalOutputJSON,
  decodeOutputBytes,
  signOutputPacket,
  Utils,
  Transaction,
  retainOutputCapability,
  type OutputCapabilityRecoveryRequest,
  type OutputReleasePolicy,
  type OutputReleaseEvidence,
  type OutputPurchaseEnvelope
} from '@bsv/sdk'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { createPrivatePurchaseRouter } from '../PrivatePurchaseRoutes.js'
import { Engine } from '../../../overlay/src/Engine.js'
import { OverlayPurchaseAdmission } from '../../../overlay/src/PurchaseAdmission.js'
import { MongoOverlayStorage } from '../../../overlay/src/storage/mongo/MongoOverlayStorage.js'
import { bootstrapMongoOverlay } from '../../../overlay/src/storage/mongo/MongoSchema.js'
import { getAdmissionHistory } from '../../../overlay/src/storage/AdmissionStorage.js'
import {
  OVERLAY_ENGINE_POLICY_ID,
  overlayAdmissionContextDigest
} from '../../../overlay/src/EngineAdmission.js'
import { timedRetainedTopicAdmission } from '../../../overlay/src/RetainedTopicAdmission.js'
import { createMongoReplicaFixture } from '../../../overlay/src/__tests/mongo/MongoReplicaFixture.js'
import { PrivateServiceDomain } from '../../../../application/output-knowledge/src/private/PrivateServiceDomain.js'
import { NodeProtectedPayloadCodec } from '../../../../application/output-knowledge/src/private/NodeProtectedPayloadCodec.js'
import { PrivatePurchaseContracts } from '../../../../application/output-knowledge/src/private/PrivatePurchaseContracts.js'
import { PrivatePurchaseAliasCoordinator } from '../../../../application/output-knowledge/src/private/PrivatePurchaseAliasCoordinator.js'
import { PrivatePurchaseAccess } from '../../../../application/output-knowledge/src/private/PrivatePurchaseAccess.js'
import { PrivatePurchaseDisclosure } from '../../../../application/output-knowledge/src/private/PrivatePurchaseDisclosure.js'
import { SQLitePrivatePurchaseAliasStore } from '../../../../application/output-knowledge/src/private/SQLitePrivatePurchaseAliasStore.js'
import { SDKPrivateReleaseEvidence } from '../../../../application/output-knowledge/src/private/SDKPrivateReleaseEvidence.js'
import { RevenueListingProfileLineageVerifier } from '../../../../application/output-knowledge/src/revenue-listing/RevenueListingProfileLineageVerifier.js'
import { RevenueListingProfilePurchaseVerifier } from '../../../../application/output-knowledge/src/revenue-listing/RevenueListingProfilePurchaseVerifier.js'
import { SQLiteProtectedOperationObjectStore } from '../../../../application/output-knowledge/src/operations/SQLiteProtectedOperationObjectStore.js'
import { nativeProfilePurchaseWalletFixture } from '../../../../application/output-knowledge/test/private-purchase-wallet-profile.fixture.js'
import type {
  ChainViewResolver,
  VerificationContext
} from '../../../../application/output-knowledge/src/index.js'
import { profile as family } from '../../../../application/output-knowledge/test/revenue-profile.fixture.js'
import {
  REVENUE_LISTING_PURCHASE_PROFILE,
  REVENUE_LISTING_LINEAGE_SCHEMA
} from '../../../../application/output-knowledge/src/revenue-listing/RevenueListingPurchaseVerifier.js'
import { SQLitePrivatePurchaseAliases } from '../../../../application/output-knowledge/src/private/SQLitePrivatePurchaseAliases.js'
import { SDKPrivatePurchaseAliasCurrentness } from '../../../../application/output-knowledge/src/private/SDKPrivatePurchaseAliasCurrentness.js'
import { PrivatePurchaseAliasDisclosure } from '../../../../application/output-knowledge/src/private/PrivatePurchaseAliasDisclosure.js'
import { PrivatePurchaseBuyerAliasCurrentness } from '../../../../application/output-knowledge/src/private/PrivatePurchaseBuyerAliasCurrentness.js'
import { lchCovenantProfileFixture } from '../../../../content/lch/test/overlay-acquisition-covenant-profile.fixture.js'
import { LCHOverlayCovenantProfileSeller } from '../../../../content/lch/src/overlayAcquisitionCovenantProfileSeller.js'
import {
  LCHOverlayCovenantProfileDomain,
  type LCHOverlayCovenantProfileDomainOptions
} from '../../../../content/lch/src/overlayAcquisitionCovenantProfile.js'
import { lchOverlayCustodyBinding } from '../../../../content/lch/src/overlayAcquisitionCustody.js'

const cleanup = new Set<() => Promise<void>>()
afterEach(async () => {
  await [...cleanup].reverse().reduce((previous, close) => previous.then(close), Promise.resolve())
})

/** Current immutable reserve/activation/purchase Script and full lineage, native noSend wallet, authenticated HTTP,
 * retained Engine/Mongo acceptance and encrypted LCH playback. Public fixture
 * keys only. This does not broadcast or establish a live-chain/mined outcome.
 * Both roles independently inspect the selected host's actual retained history.
 * Separate alias currentness uses fully checked synthetic header ancestry;
 * historical License/settlement/POTATOES remain byte exact through later forks.
 */
export async function privatePurchaseProfileAliasNativeFixture(
  verification?: {
    chains: ChainViewResolver
    view(): VerificationContext
  },
  releasePolicy: OutputReleasePolicy = { kind: 'local-admission' }
) {
  const resources: (() => Promise<void>)[] = []
  let disposed = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    cleanup.delete(dispose)
    const errors: unknown[] = []
    await resources.reverse().reduce(
      (previous, close) =>
        previous.then(async () => {
          try {
            await close()
          } catch (error) {
            errors.push(error)
          }
        }),
      Promise.resolve()
    )
    if (errors.length) throw new AggregateError(errors, 'Reference cleanup failed')
  }
  const track = (stop: () => unknown | Promise<unknown>) => {
    let closed = false
    const close = async () => {
      if (closed) return
      closed = true
      await stop()
    }
    resources.push(close)
    return close
  }
  cleanup.add(dispose)
  const now = Math.floor(Date.now() / 1000),
    clock = () => String(Math.floor(Date.now() / 1000))
  let asset!: Awaited<ReturnType<typeof lchCovenantProfileFixture>>
  const native = await nativeProfilePurchaseWalletFixture(524288, 1000, {
      maximumVerifiedHeight: 103,
      application: async ({ chain, anchor }) => {
        asset = await lchCovenantProfileFixture({
          chain,
          anchor,
          now,
          embedCiphertext: false,
          maximumRequestBytes: 524288,
          releasePolicy
        })
        return {
          descriptor: asset.descriptor,
          prepare: asset.prepare,
          sellerKey: asset.sellerKey,
          buyerKeyCode: 84,
          now,
          releasePolicy
        }
      }
    }),
    chain = native.selected
  track(() => native.close())
  const replica = await createMongoReplicaFixture()
  track(() => replica.close())
  const directory = mkdtempSync(join(tmpdir(), 'private-purchase-profile-alias-native-'))
  track(() => rmSync(directory, { recursive: true, force: true }))
  asset.prepare.listing = native.prepare.listing
  const verificationChains = verification?.chains ?? native.chains,
    view = () => {
      const selected = structuredClone(verification?.view() ?? native.currentContext())
      outputAssert(
        selected.view.chain.genesisHash === chain.genesisHash,
        'Unselected fixture genesis'
      )
      selected.view.chain = chain
      return selected
    },
    scope = { ...chain, nodeId: 'licensed-reference-' + randomUUID() }
  await bootstrapMongoOverlay(replica.db, scope)
  const storage = new MongoOverlayStorage(replica.db, scope, { retainAdmissionHistory: true })
  track(() => storage.close())
  const counts = { admission: 0, issuance: 0 },
    selected = await verificationChains.resolve(view().view, new AbortController().signal)
  const engine = new Engine(
    {
      [asset.prepare.topic]: {
        identifyAdmissibleOutputs: async beef => {
          const tx = Transaction.fromBEEF(beef)
          // The independently validated listing policy admits only this original
          // listing and its exact-script successors; Engine verifies every Script.
          return {
            outputsToAdmit: tx.outputs.flatMap((output, index) =>
              output.lockingScript.toHex() === family.lock('active', asset.descriptor).toHex()
                ? [index]
                : []
            ),
            coinsToRetain: []
          }
        },
        getDocumentation: async () => 'Disclosed synthetic licensed listing',
        getMetaData: async () => ({
          name: 'Licensed listing',
          shortDescription: 'Reference covenant topic'
        })
      }
    },
    {},
    storage,
    selected.tracker
  )
  const submit = engine.submit.bind(engine)
  engine.submit = (...args) => {
    counts.admission++
    return submit(...args)
  }
  const installation = {
      chain,
      seller: asset.body.identity,
      baseURL: asset.body.baseURL,
      topic: asset.prepare.topic,
      rulesDigest: asset.selection.service.rulesDigest,
      releasePolicy,
      domainProfile: REVENUE_LISTING_PURCHASE_PROFILE,
      domainSchema: REVENUE_LISTING_LINEAGE_SCHEMA,
      maximumRequestBytes: 524288,
      maximumResponseBytes: 4194304,
      maximumPurchaseSeconds: '80',
      maximumRecoverySeconds: '172800'
    },
    rules = new Map([[asset.selection.service.rules.id, () => {}]]),
    contracts = new PrivatePurchaseContracts(installation, {
      maximumAgeSeconds: '100',
      clockSkewSeconds: '0',
      rules
    }),
    configuration = {
      identity: { chain, seller: asset.body.identity },
      indexKeyId: 'public-fixture-index',
      capacity: {
        storeId: 'bc'.repeat(32),
        maximumRecords: 512,
        maximumReservedBytes: 32 * 1048576,
        maximumRecordBytes: 2 * 1048576
      },
      application: { profile: 'native-current-alias-licensed-purchase-reference/1' }
    },
    index = createSecretKey(Buffer.alloc(32, 41)),
    payload = createSecretKey(Buffer.alloc(32, 42)),
    codec = new NodeProtectedPayloadCodec(
      { resolve: () => payload },
      'public-fixture-payload',
      2 * 1048576
    ),
    policy = { id: 'full-native-licensed-purchase', digest: 'ab'.repeat(32) },
    limits = {
      maximumStateBytes: 600000,
      maximumOriginalBytes: 2097152,
      maximumCandidateBytes: 524288,
      maximumResultBytes: 4194304,
      maximumOutcomeBytes: 131072,
      maximumBatchBytes: 24 * 1048576
    },
    proofLimits = {
      maximumCandidateBytes: 524288,
      maximumUnconfirmed: 4,
      maximumPending: 2,
      maximumWrites: 64,
      maximumBatchBytes: 24 * 1048576
    },
    lineage = new RevenueListingProfileLineageVerifier(family, verificationChains),
    purchase = new RevenueListingProfilePurchaseVerifier(family, verificationChains),
    release = new SDKPrivateReleaseEvidence(verificationChains),
    trust: OutputCapabilityRecoveryRequest = {
      identity: asset.body.identity,
      baseURL: asset.body.baseURL,
      chain,
      kind: 'topic',
      service: asset.prepare.topic,
      profile: asset.selection.profile.id,
      rules
    },
    retained = retainOutputCapability(asset.selection.manifest, {
      ...trust,
      now: clock(),
      maximumAgeSeconds: '100',
      clockSkewSeconds: '0'
    }).record
  let permitted = true,
    buyerHeight: number | undefined,
    available = true,
    active: ReturnType<typeof install>
  const current = () => permitted,
    checked = () => {
      outputAssert(current(), 'Reference recipient/context changed', 'context-changed')
    },
    verificationGuard = (selected: VerificationContext) => {
      const binding = canonicalOutputJSON({
        partition: selected.partition,
        generation: selected.generation,
        view: selected.view,
        policyDigest: selected.policyDigest
      })
      return () => {
        checked()
        const active = view()
        outputAssert(
          binding ===
            canonicalOutputJSON({
              partition: active.partition,
              generation: active.generation,
              view: active.view,
              policyDigest: active.policyDigest
            }),
          'Independent selected view changed',
          'context-changed'
        )
      }
    },
    buyerView = () => (buyerHeight === undefined ? view() : native.currentContext(buyerHeight)),
    buyerVerificationGuard = (selected: VerificationContext) => {
      const binding = canonicalOutputJSON({
        partition: selected.partition,
        generation: selected.generation,
        view: selected.view,
        policyDigest: selected.policyDigest
      })
      return () => {
        checked()
        const current = buyerView()
        outputAssert(
          binding ===
            canonicalOutputJSON({
              partition: current.partition,
              generation: current.generation,
              view: current.view,
              policyDigest: current.policyDigest
            }),
          'Independent buyer selected view changed',
          'context-changed'
        )
      }
    },
    buyerLineage = new RevenueListingProfileLineageVerifier(family, verificationChains),
    buyerPurchase = new RevenueListingProfilePurchaseVerifier(family, verificationChains),
    validateLineage = async (
      input: Parameters<typeof lineage.verify>[0],
      expected: { request: typeof asset.prepare; descriptor: typeof asset.descriptor },
      signal: AbortSignal
    ) => {
      const selectedView = view(),
        result = await lineage.verify(input, selectedView, signal),
        stillCurrent = verificationGuard(selectedView)
      outputAssert(
        result.status === 'verified' &&
          canonicalOutputJSON(result.target) === canonicalOutputJSON(expected.request.listing) &&
          canonicalOutputJSON(result.descriptor) === canonicalOutputJSON(expected.descriptor),
        'Complete selected lineage refused: ' + canonicalOutputJSON(result)
      )
      stillCurrent()
      return {
        stage: result.stage,
        currentHeight: selectedView.view.tipHeight,
        checkCurrent: stillCurrent
      }
    },
    validatePurchase = async (
      ...args: [
        Parameters<typeof purchase.verify>[0],
        Parameters<typeof purchase.verify>[1],
        AbortSignal
      ]
    ) => {
      const selectedView = view(),
        result = await purchase.verify(args[0], args[1], selectedView, args[2]),
        stillCurrent = verificationGuard(selectedView)
      outputAssert(
        result.status === 'verified',
        'Complete selected purchase refused: ' + canonicalOutputJSON(result)
      )
      stillCurrent()
      return { purchaseCommitment: result.purchaseCommitment, checkCurrent: stillCurrent }
    },
    validateBuyerLineage = async (
      packet: Parameters<typeof buyerLineage.verify>[0],
      expected: { request: typeof asset.prepare; descriptor: typeof asset.descriptor },
      signal: AbortSignal
    ) => {
      const selected = buyerView(),
        result = await buyerLineage.verify(packet, selected, signal),
        checkCurrent = buyerVerificationGuard(selected)
      outputAssert(
        result.status === 'verified' &&
          canonicalOutputJSON(result.target) === canonicalOutputJSON(expected.request.listing) &&
          canonicalOutputJSON(result.descriptor) === canonicalOutputJSON(expected.descriptor),
        'Independent buyer lineage refused: ' + canonicalOutputJSON(result)
      )
      checkCurrent()
      return { stage: result.stage, currentHeight: selected.view.tipHeight, checkCurrent }
    },
    validateBuyerPurchase = async (
      candidate: Parameters<typeof buyerPurchase.verify>[0],
      original: Parameters<typeof buyerPurchase.verify>[1],
      signal: AbortSignal
    ) => {
      const selected = buyerView(),
        result = await buyerPurchase.verify(candidate, original, selected, signal),
        checkCurrent = buyerVerificationGuard(selected)
      outputAssert(
        result.status === 'verified',
        'Independent buyer purchase refused: ' + canonicalOutputJSON(result)
      )
      checkCurrent()
      return { purchaseCommitment: result.purchaseCommitment, checkCurrent }
    },
    releaseAssessment = async (
      evidence: Parameters<typeof release.verify>[0],
      expected: Parameters<typeof release.verify>[1],
      signal: AbortSignal
    ) => {
      const stillCurrent = verificationGuard(view()),
        id = native.terms.body.acquisitionId,
        loaded = active.store.load(id, asset.prepare.recipient, clock, checked)
      outputAssert(
        loaded?.candidate && loaded.progress.txid === expected.txid,
        'Original private admission missing',
        'unavailable'
      )
      const query = {
          scope,
          txid: expected.txid,
          topic: asset.prepare.topic,
          policyId: OVERLAY_ENGINE_POLICY_ID,
          contextDigest: overlayAdmissionContextDigest()
        },
        history = await getAdmissionHistory(storage)!.read(query)
      outputAssert(
        history.state === 'committed',
        'Original topical admission unresolved',
        'unavailable'
      )
      const originalAdmission = timedRetainedTopicAdmission(
        history.admission,
        query,
        Transaction.fromBEEF(decodeOutputBytes(loaded.candidate.beef, 524288), expected.txid)
      )
      return release.verify(
        evidence,
        expected,
        {
          now: clock(),
          localAcceptedAt: originalAdmission.acceptedAt,
          verification: expected.policy.kind === 'mined' ? view() : undefined,
          current: () => {
            stillCurrent()
            return true
          }
        },
        signal
      )
    },
    seller = new LCHOverlayCovenantProfileSeller({
      id: 'actual-current-native-alias-licensed-reference',
      catalogue: {
        load: async () => {
          outputAssert(available, 'Catalogue withdrawn', 'unavailable')
          return {
            header: asset.input.header,
            offer: asset.offer,
            descriptor: asset.descriptor,
            lineage: native.lineage,
            keys: [...asset.asset.keys].map(([key, cek]) => ({
              keyId: Uint8Array.from(Utils.toArray(key, 'hex')),
              cek
            }))
          }
        }
      },
      source: asset.storage,
      sellerSigner: asset.seller,
      issuerSigner: asset.seller,
      issuerWallet: asset.sellerWallet,
      authorityNetwork: 'testnet',
      maximumCiphertextBytes: 1048576,
      purchaseSeconds: '80',
      clock,
      current,
      verification: {
        id: 'actual-genesis-script-and-native-admission',
        lineage: validateLineage,
        purchase: validatePurchase,
        release: releaseAssessment
      }
    }),
    admission = new OverlayPurchaseAdmission({
      engine,
      identity: asset.body.identity,
      topic: asset.prepare.topic,
      rulesDigest: asset.selection.service.rulesDigest,
      baseURL: asset.body.baseURL,
      rules,
      domainProfile: REVENUE_LISTING_PURCHASE_PROFILE,
      admittedOutputIndex: 0,
      maximumRequestBytes: 524288
    })
  const issue = seller.issue.bind(seller)
  seller.issue = (...args) => {
    counts.issuance++
    return issue(...args)
  }
  function install(create: boolean) {
    const domain = PrivateServiceDomain[create ? 'create' : 'open'](
        join(directory, 'seller.sqlite'),
        configuration,
        { resolve: () => index },
        codec
      ),
      closeDomain = track(() => domain.close()),
      aliases = new SQLitePrivatePurchaseAliases(domain, contracts, proofLimits),
      store = new SQLitePrivatePurchaseAliasStore(domain, contracts, aliases, limits, policy, 8),
      access = new PrivatePurchaseAccess(
        domain,
        asset.prepare.topic,
        current,
        'full-purchase-commitment-v1',
        'alias-custody-v1'
      ),
      currentness = new SDKPrivatePurchaseAliasCurrentness(verificationChains, {
        context: async () => view(),
        current: selected => {
          verificationGuard(selected)()
          return true
        }
      }),
      coordinator = new PrivatePurchaseAliasCoordinator({
        store,
        contracts,
        serviceDomain: domain,
        aliases,
        currentness,
        access,
        domain: seller,
        admission,
        release: {
          assess: async (custody, progress, candidate, signal) => {
            outputAssert(progress.admission && progress.txid, 'Retained admission required')
            const evidence: OutputReleaseEvidence = {
              chain,
              txid: progress.txid,
              policy: custody.original.terms.body.releasePolicy,
              acceptedAt: progress.admission.acceptedAt
            }
            if (evidence.policy.kind === 'mined') {
              const placed = await currentness.assess(
                { acquisitionId: progress.acquisitionId, chain },
                candidate,
                signal
              )
              if (!placed) return undefined
              placed.placement.checkCurrent()
              evidence.blockEvidence = {
                blockHash: placed.blockHash,
                height: placed.height,
                tipHash: placed.tipHash,
                tipHeight: placed.tipHeight,
                beef: candidate.beef,
                contextId: placed.contextId,
                chainPolicyDigest: placed.chainPolicyDigest
              }
            }
            return releaseAssessment(
              evidence,
              { chain, txid: progress.txid, policy: evidence.policy },
              signal
            )
          }
        },
        validationPolicy: policy,
        clock,
        manifest: () => asset.selection.manifest,
        sign: async (kind, body) => signOutputPacket(kind, body, asset.sellerKey)
      }),
      closeCoordinator = track(() => coordinator.stop()),
      historicalDisclosure = new PrivatePurchaseDisclosure(
        domain,
        store,
        contracts,
        access,
        clock,
        current
      ),
      disclosure = new PrivatePurchaseAliasDisclosure(historicalDisclosure, coordinator)
    return {
      domain,
      store,
      aliases,
      currentness,
      coordinator,
      historicalDisclosure,
      disclosure,
      close: async () => {
        await closeCoordinator()
        await closeDomain()
      }
    }
  }
  active = install(true)
  const failures: unknown[] = []
  async function call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      failures.push(error)
      throw error
    }
  }
  const authWallet = new CompletedProtoWallet(asset.sellerKey),
    app = express(),
    server = createServer(app)
  track(async () => {
    if (!server.listening) return
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()))
      server.closeAllConnections()
    })
  })
  app.use(
    createPrivatePurchaseRouter({
      service: {
        prepare: (...args) => call(() => active.coordinator.prepare(...args)),
        submit: (...args) => call(() => active.coordinator.submit(...args)),
        recover: (...args) => call(() => active.coordinator.recover(...args))
      },
      disclosure: {
        prepare: (...args) => active.disclosure.prepare(...args),
        prepareAsync: (...args) => active.disclosure.prepareAsync(...args),
        enqueueControl: (...args) => active.disclosure.enqueueControl(...args)
      },
      identity: asset.body.identity,
      baseURL: asset.body.baseURL,
      authenticate: createAuthMiddleware({
        wallet: authWallet,
        allowUnauthenticated: true,
        transportLimits: { requestTimeoutMs: 5000 }
      }),
      requestTimeoutMs: 20000
    })
  )
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests: string[] = [],
    lostReplies: string[] = [],
    wire: typeof fetch = async (input, init) => {
      const url = fixtureURL(input)
      outputAssert(
        url.origin === new URL(asset.body.baseURL).origin,
        'Unselected reference endpoint'
      )
      requests.push(url.pathname)
      // Isolated fixture adapter maps the explicitly selected HTTPS endpoint to
      // loopback while preserving the real authenticated bytes. TLS/certificate
      // validation is not established by this local demonstration.
      const response = await fetch(origin + url.pathname, init),
        bytes = await response.arrayBuffer()
      const delivered =
        response.ok &&
        url.pathname.includes('/overlay/v1/purchases/') &&
        JSON.parse(new TextDecoder().decode(bytes)).result?.status === 'delivered'
      if (delivered && blockDelivery) {
        const pause = blockDelivery
        blockDelivery = undefined
        await pause()
      }
      const losesDelivery = lostPath === 'delivered' && delivered
      if (response.ok && (lostPath === url.pathname || losesDelivery)) {
        lostPath = undefined
        lostReplies.push(url.pathname)
        throw new Error('Lost original authenticated ' + url.pathname + ' reply')
      }
      return new Response(bytes, {
        status: response.status,
        headers: response.headers
      })
    },
    buyerDomainOptions: LCHOverlayCovenantProfileDomainOptions = {
      original: asset.input,
      source: { id: 'actual-reference-content', read: asset.storage.read.bind(asset.storage) },
      wallet: asset.buyerWallet,
      authorityNetwork: 'testnet',
      maximumCiphertextBytes: 1048576,
      clock,
      current,
      verification: {
        id: 'independent-actual-native-reference',
        preparation: async (packet, request, descriptor, signal) =>
          validateBuyerLineage(
            JSON.parse(
              new TextDecoder().decode(
                Uint8Array.from(decodeOutputBytes(packet.body.domainEvidence.bytes, 2097152))
              )
            ),
            { request, descriptor },
            signal
          ),
        candidate: (candidate, original, signal) =>
          validateBuyerPurchase(candidate, original, signal),
        purchase: (evidence, original, signal) =>
          validateBuyerPurchase(evidence.purchase, original, signal),
        release: releaseAssessment
      }
    }
  let buyerDomain = await LCHOverlayCovenantProfileDomain.create(buyerDomainOptions),
    lostPath: string | undefined,
    blockDelivery: (() => Promise<void>) | undefined
  const retainedLCH = { id: buyerDomain.id, original: buyerDomain.original() },
    objectConfiguration = {
      storeId: 'bd'.repeat(32),
      recipient: asset.prepare.recipient,
      binding: lchOverlayCustodyBinding(buyerDomain.id),
      maximumObjects: 2,
      maximumObjectBytes: 2097152
    },
    objects = SQLiteProtectedOperationObjectStore.create(
      join(directory, 'license.sqlite'),
      objectConfiguration,
      codec
    )
  let closeLicense = track(() => objects.close())
  await buyerDomain.initializeCustody(objects)
  const buyerOptions: Omit<PrivatePurchaseBuyerOptions, 'state' | 'objects'> = {
      original: { contract: retained, request: asset.prepare },
      trust,
      payment: native.payment,
      validation: buyerDomain,
      wallet: new CompletedProtoWallet(asset.buyerKey),
      fetch: wire,
      clock,
      current,
      candidateProfile: 'full-purchase-commitment-v1' as const,
      objectReadProfile: 'joint-custody-v1' as const
    },
    buyerBinding = privatePurchaseBuyerBinding(buyerOptions),
    stateCodec = fixtureCustody(),
    stateOptions = { binding: buyerBinding, maximumValueBytes: 16384 },
    stateBinding = protectedOperationBinding(stateOptions, stateCodec),
    buyerObjectConfiguration = {
      storeId: 'be'.repeat(32),
      recipient: asset.prepare.recipient,
      binding: buyerBinding,
      maximumObjects: 7,
      maximumObjectBytes: 4194304
    }
  async function openBuyer(create = false, payment = native.payment) {
    const stateOwner = create
        ? SQLiteOperationStateStore.create(
            join(directory, 'buyer-state.sqlite'),
            'licensed-buyer',
            stateBinding,
            PROTECTED_OPERATION_INITIAL
          )
        : SQLiteOperationStateStore.open(
            join(directory, 'buyer-state.sqlite'),
            'licensed-buyer',
            stateBinding
          ),
      state = create
        ? await ProtectedOperationStateStore.initialize(
            stateOwner,
            stateCodec,
            stateOptions,
            PRIVATE_PURCHASE_BUYER_INITIAL
          )
        : await ProtectedOperationStateStore.open(stateOwner, stateCodec, stateOptions),
      objects = SQLiteProtectedOperationObjectStore[create ? 'create' : 'open'](
        join(directory, 'buyer-objects.sqlite'),
        buyerObjectConfiguration,
        codec
      )
    const closeState = track(() => state.close()),
      closeObjects = track(() => objects.close()),
      buyer = await PrivatePurchaseBuyer[create ? 'initialize' : 'open']({
        ...buyerOptions,
        payment,
        validation: buyerDomain,
        state,
        objects
      }),
      closeBuyer = track(() => buyer.stop()),
      aliasCurrentness = new PrivatePurchaseBuyerAliasCurrentness({
        seller: asset.descriptor.seller,
        domainProfile: REVENUE_LISTING_PURCHASE_PROFILE,
        validation: buyerDomain,
        currentness: new SDKPrivatePurchaseAliasCurrentness(verificationChains, {
          context: async () => buyerView(),
          current: selected => {
            buyerVerificationGuard(selected)()
            return true
          }
        })
      })
    return {
      buyer,
      state,
      aliasCurrentness,
      close: async () => {
        await closeBuyer()
        await closeState()
        await closeObjects()
      }
    }
  }
  return {
    openBuyer,
    async proveCandidate(candidate: Parameters<typeof native.proveCandidate>[0]) {
      const proved = native.proveCandidate(candidate)
      engine.chainTracker = (
        await verificationChains.resolve(view().view, new AbortController().signal)
      ).tracker
      return proved
    },
    async regressProof() {
      native.regressProof()
      engine.chainTracker = (
        await verificationChains.resolve(view().view, new AbortController().signal)
      ).tracker
    },
    selectBuyerHeight(value?: number) {
      buyerHeight = value
    },
    counts,
    view,
    failures,
    asset,
    native,
    engine,
    storage,
    trust,
    retained,
    clock,
    requests,
    lostReplies,
    wire,
    get buyerDomain() {
      return buyerDomain
    },
    wallet: new CompletedProtoWallet(asset.buyerKey),
    get active() {
      return active
    },
    withdraw() {
      available = false
    },
    setPermitted(value: boolean) {
      permitted = value
    },
    async reopenSeller() {
      await active.close()
      active = install(false)
    },
    async reopenLicense() {
      await closeLicense()
      const reopened = SQLiteProtectedOperationObjectStore.open(
        join(directory, 'license.sqlite'),
        objectConfiguration,
        codec
      )
      closeLicense = track(() => reopened.close())
      buyerDomain = await LCHOverlayCovenantProfileDomain.open(
        buyerDomainOptions,
        retainedLCH,
        reopened
      )
    },
    loseReply(path: 'prepare' | 'delivery') {
      lostPath =
        path === 'delivery'
          ? 'delivered'
          : new URL(asset.body.baseURL).pathname.replace(/\/$/, '') +
            '/overlay/v1/purchases/' +
            path
    },
    pauseDelivery() {
      let enter = () => {},
        release = () => {}
      const entered = new Promise<void>(resolve => {
          enter = resolve
        }),
        pending = new Promise<void>(resolve => {
          release = resolve
        })
      blockDelivery = async () => {
        enter()
        await pending
      }
      track(release)
      return { entered, release }
    },
    async close() {
      await active.coordinator.stop()
      await dispose()
    },
    async playback(delivered: OutputPurchaseEnvelope) {
      return buyerDomain.playback(delivered, new AbortController().signal)
    }
  }
}

function fixtureURL(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === 'string') return new URL(input)
  if (input instanceof URL) return new URL(input.href)
  return new URL(input.url)
}
