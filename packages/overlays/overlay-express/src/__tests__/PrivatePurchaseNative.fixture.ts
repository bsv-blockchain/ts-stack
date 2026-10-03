import {
  PrivatePurchaseBuyer,
  privatePurchaseBuyerBinding,
  PRIVATE_PURCHASE_BUYER_INITIAL
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
import { PrivatePurchaseCoordinator } from '../../../../application/output-knowledge/src/private/PrivatePurchaseCoordinator.js'
import { PrivatePurchaseAccess } from '../../../../application/output-knowledge/src/private/PrivatePurchaseAccess.js'
import { PrivatePurchaseDisclosure } from '../../../../application/output-knowledge/src/private/PrivatePurchaseDisclosure.js'
import { SQLitePrivatePurchaseStore } from '../../../../application/output-knowledge/src/private/SQLitePrivatePurchaseStore.js'
import { SQLitePrivatePurchaseEvidence } from '../../../../application/output-knowledge/src/private/SQLitePrivatePurchaseEvidence.js'
import { SDKPrivateReleaseEvidence } from '../../../../application/output-knowledge/src/private/SDKPrivateReleaseEvidence.js'
import { RevenueListingLineageVerifier } from '../../../../application/output-knowledge/src/revenue-listing/RevenueListingLineageVerifier.js'
import {
  RevenueListingPurchaseVerifier,
  REVENUE_LISTING_PURCHASE_PROFILE,
  REVENUE_LISTING_LINEAGE_SCHEMA
} from '../../../../application/output-knowledge/src/revenue-listing/RevenueListingPurchaseVerifier.js'
import { SQLiteProtectedOperationObjectStore } from '../../../../application/output-knowledge/src/operations/SQLiteProtectedOperationObjectStore.js'
import { nativePurchaseWalletFixture } from '../../../../application/output-knowledge/test/private-purchase-wallet-native.fixture.js'
import type {
  ChainViewResolver,
  VerificationContext
} from '../../../../application/output-knowledge/src/index.js'
import {
  completeGenesis,
  chains,
  context,
  family
} from '../../../../application/output-knowledge/test/revenue-lineage-fixture.js'
import { lchCovenantFixture } from '../../../../content/lch/test/overlay-acquisition-covenant.fixture.js'
import { LCHOverlayCovenantSeller } from '../../../../content/lch/src/overlayAcquisitionCovenantSeller.js'
import {
  LCHOverlayCovenantDomain,
  type LCHOverlayCovenantDomainOptions
} from '../../../../content/lch/src/overlayAcquisitionCovenant.js'
import { lchOverlayCustodyBinding } from '../../../../content/lch/src/overlayAcquisitionCustody.js'

const cleanup = new Set<() => Promise<void>>()
afterEach(async () => {
  await [...cleanup].reverse().reduce((previous, close) => previous.then(close), Promise.resolve())
})

/** Real synthetic-chain Script/history, native noSend wallet, authenticated HTTP,
 * retained Engine/Mongo acceptance and encrypted LCH playback. Public fixture
 * keys only. This does not broadcast or establish a live-chain/mined outcome.
 * Both roles independently inspect the selected host's real retained history.
 */
export async function privatePurchaseNativeFixture(verification?: {
  chains: ChainViewResolver
  view(): VerificationContext
}) {
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
    clock = () => String(Math.floor(Date.now() / 1000)),
    original = completeGenesis(),
    chain = { ...original.descriptor.chain, network: 'mock' },
    asset = await lchCovenantFixture({
      chain,
      anchor: { ...original.descriptor.lineageAnchor, chain },
      now,
      embedCiphertext: false,
      maximumRequestBytes: 524288
    }),
    native = await nativePurchaseWalletFixture(524288, {
      descriptor: asset.descriptor,
      prepare: asset.prepare,
      sellerKey: asset.sellerKey,
      buyerKeyCode: 84,
      now
    })
  track(() => native.close())
  const replica = await createMongoReplicaFixture()
  track(() => replica.close())
  const directory = mkdtempSync(join(tmpdir(), 'private-purchase-native-'))
  track(() => rmSync(directory, { recursive: true, force: true }))
  asset.prepare.listing = native.prepare.listing
  const verificationChains = verification?.chains ?? chains,
    view = () => {
      const selected = structuredClone(verification?.view() ?? context())
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
              output.lockingScript.toHex() === family.lock(asset.descriptor).toHex() ? [index] : []
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
      releasePolicy: { kind: 'local-admission' as const },
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
        maximumRecords: 128,
        maximumReservedBytes: 16 * 1048576,
        maximumRecordBytes: 2 * 1048576
      },
      application: { profile: 'native-licensed-purchase-reference/1' }
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
      maximumBatchBytes: 12 * 1048576
    },
    proofLimits = {
      maximumCandidateBytes: 524288,
      maximumUpdates: 8,
      maximumTransactions: 4096,
      maximumDependencies: 16384
    },
    lineage = new RevenueListingLineageVerifier(family, verificationChains),
    purchase = new RevenueListingPurchaseVerifier(family, verificationChains),
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
      return { checkCurrent: stillCurrent }
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
      return { checkCurrent: stillCurrent }
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
          current: () => {
            stillCurrent()
            return true
          }
        },
        signal
      )
    },
    seller = new LCHOverlayCovenantSeller({
      id: 'actual-native-licensed-reference',
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
      store = new SQLitePrivatePurchaseStore(
        domain,
        contracts,
        limits,
        policy,
        'native-observation-v1'
      ),
      evidence = new SQLitePrivatePurchaseEvidence(domain, contracts, proofLimits),
      access = new PrivatePurchaseAccess(domain, asset.prepare.topic, current),
      coordinator = new PrivatePurchaseCoordinator({
        store,
        contracts,
        evidence,
        access,
        domain: seller,
        admission,
        release: {
          assess: async (custody, progress, _candidate, signal) => {
            outputAssert(progress.admission && progress.txid, 'Retained admission required')
            const evidence = {
              chain,
              txid: progress.txid,
              policy: custody.original.terms.body.releasePolicy,
              acceptedAt: progress.admission.acceptedAt
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
      disclosure = new PrivatePurchaseDisclosure(domain, store, contracts, access, clock, current)
    return {
      domain,
      store,
      evidence,
      coordinator,
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
    buyerDomainOptions: LCHOverlayCovenantDomainOptions = {
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
          validateLineage(
            JSON.parse(
              new TextDecoder().decode(
                Uint8Array.from(decodeOutputBytes(packet.body.domainEvidence.bytes, 2097152))
              )
            ),
            { request, descriptor },
            signal
          ),
        purchase: (evidence, original, signal) =>
          validatePurchase(evidence.purchase, original, signal),
        release: releaseAssessment
      }
    }
  let buyerDomain = await LCHOverlayCovenantDomain.create(buyerDomainOptions),
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
  const buyerOptions = {
      original: { contract: retained, request: asset.prepare },
      trust,
      payment: native.payment,
      validation: buyerDomain,
      wallet: new CompletedProtoWallet(asset.buyerKey),
      fetch: wire,
      clock,
      current
    },
    buyerBinding = privatePurchaseBuyerBinding(buyerOptions),
    stateCodec = fixtureCustody(),
    stateOptions = { binding: buyerBinding, maximumValueBytes: 16384 },
    stateBinding = protectedOperationBinding(stateOptions, stateCodec),
    buyerObjectConfiguration = {
      storeId: 'be'.repeat(32),
      recipient: asset.prepare.recipient,
      binding: buyerBinding,
      maximumObjects: 6,
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
      closeBuyer = track(() => buyer.stop())
    return {
      buyer,
      close: async () => {
        await closeBuyer()
        await closeState()
        await closeObjects()
      }
    }
  }
  return {
    openBuyer,
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
      buyerDomain = await LCHOverlayCovenantDomain.open(buyerDomainOptions, retainedLCH, reopened)
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
