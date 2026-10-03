import { afterEach, jest } from '@jest/globals'
import { createSecretKey } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  CompletedProtoWallet,
  PrivateKey,
  OUTPUT_PROFILES,
  OutputPurchaseTransport,
  outputAssert,
  parseOutputPurchaseTerms,
  parseOutputPurchaseEnvelope,
  type OutputCapabilityRecoveryRequest,
  type OutputPurchaseEnvelope,
  type OutputSignedPurchaseTerms
} from '@bsv/sdk'
import { SQLiteOperationStateStore } from '../src/operations/SQLiteOperationStateStore.js'
import {
  ProtectedOperationStateStore,
  protectedOperationBinding,
  PROTECTED_OPERATION_INITIAL
} from '../src/operations/ProtectedOperationStateStore.js'
import { SQLiteProtectedOperationObjectStore } from '../src/operations/SQLiteProtectedOperationObjectStore.js'
import { NodeProtectedPayloadCodec } from '../src/private/NodeProtectedPayloadCodec.js'
import {
  PrivatePurchaseBuyer,
  privatePurchaseBuyerBinding,
  PRIVATE_PURCHASE_BUYER_INITIAL,
  type PrivatePurchaseBuyerOptions
} from '../src/private/PrivatePurchaseBuyer.js'
import { purchaseCoordinatorFixture } from './private-purchase-coordinator.fixture.js'
import { custody } from './protected-operation-object.fixture.js'
const cleanup = new Set<() => Promise<void>>()
afterEach(async () => {
  await [...cleanup].reduce((sequence, close) => sequence.then(close), Promise.resolve())
  cleanup.clear()
  jest.restoreAllMocks()
})
/** Actual independent SQLite protected owners and native seller journal. Wallet,
 * domain and admission premises remain controlled lifecycle fixtures here. */
export function purchaseBuyerFixture() {
  const server = purchaseCoordinatorFixture(),
    contract = server.f.f.f,
    directory = mkdtempSync(join(tmpdir(), 'purchase-buyer-')),
    codec = custody(),
    objectCodec = new NodeProtectedPayloadCodec(
      { resolve: () => createSecretKey(Buffer.alloc(32, 44)) },
      'fixture'
    ),
    signed = contract.original(),
    trust: OutputCapabilityRecoveryRequest = {
      ...contract.trust,
      identity: contract.installation.seller,
      baseURL: contract.installation.baseURL,
      chain: contract.chain,
      kind: 'topic',
      service: contract.installation.topic,
      profile: OUTPUT_PROFILES.purchase
    }
  let now = '20',
    allowed = true,
    finalized = false,
    valid = true,
    usable = true,
    lost: 'prepare' | 'finish' | 'submit' | undefined
  const counts = { plan: 0, recover: 0, finish: 0, preflight: 0, verify: 0, usable: 0 },
    calls: string[] = []
  const payment: PrivatePurchaseBuyerOptions['payment'] = {
    maximumCandidateBytes: 65536,
    configuration: {
      wallet: contract.request.recipient,
      storage: 'fixture',
      protocol: 'controlled-durable-action'
    },
    plan: async id => {
      counts.plan++
      await Promise.resolve()
      return { operationId: id }
    },
    recover: async () => {
      counts.recover++
      await Promise.resolve()
      return finalized
        ? { state: 'finalized', candidate: structuredClone(server.f.candidate) }
        : { state: 'absent' }
    },
    finish: async (_plan, guard) => {
      guard()
      counts.finish++
      finalized = true
      await Promise.resolve()
      if (lost === 'finish') {
        lost = undefined
        throw new Error('Lost original wallet reply')
      }
      return structuredClone(server.f.candidate)
    }
  }
  const validation: PrivatePurchaseBuyerOptions['validation'] = {
    id: 'urn:test:purchase-buyer-domain',
    preflight: async () => {
      counts.preflight++
      await Promise.resolve()
      outputAssert(valid, 'Controlled invalid domain')
    },
    verify: async () => {
      counts.verify++
      await Promise.resolve()
      outputAssert(valid, 'Controlled invalid material')
    },
    usable: async () => {
      counts.usable++
      await Promise.resolve()
      return usable
    }
  }
  const partial = {
      original: { contract: signed.capability, request: contract.request },
      trust,
      payment,
      validation,
      wallet: new CompletedProtoWallet(new PrivateKey(44)),
      clock: () => now,
      current: () => allowed
    },
    binding = privatePurchaseBuyerBinding(partial),
    protectedOptions = { binding, maximumValueBytes: 16384 },
    stateBinding = protectedOperationBinding(protectedOptions, codec),
    objectConfiguration = {
      storeId: '96'.repeat(32),
      recipient: contract.request.recipient,
      binding,
      maximumObjects: 6,
      maximumObjectBytes: 4194304
    }
  const stores: {
      state: ProtectedOperationStateStore
      objects: SQLiteProtectedOperationObjectStore
    }[] = [],
    buyers: PrivatePurchaseBuyer[] = []
  async function open(create = false, overrides: Partial<PrivatePurchaseBuyerOptions> = {}) {
    const base = create
        ? SQLiteOperationStateStore.create(
            join(directory, 'state.sqlite'),
            'buyer',
            stateBinding,
            PROTECTED_OPERATION_INITIAL
          )
        : SQLiteOperationStateStore.open(join(directory, 'state.sqlite'), 'buyer', stateBinding),
      state = create
        ? await ProtectedOperationStateStore.initialize(
            base,
            codec,
            protectedOptions,
            PRIVATE_PURCHASE_BUYER_INITIAL
          )
        : await ProtectedOperationStateStore.open(base, codec, protectedOptions),
      objects = SQLiteProtectedOperationObjectStore[create ? 'create' : 'open'](
        join(directory, 'objects.sqlite'),
        objectConfiguration,
        objectCodec
      ),
      ports = { ...partial, state, objects, ...overrides }
    stores.push({ state, objects })
    const buyer = await PrivatePurchaseBuyer[create ? 'initialize' : 'open'](ports)
    buyers.push(buyer)
    return { buyer, ports, state, objects }
  }
  const send = jest
    .spyOn(OutputPurchaseTransport.prototype, 'send')
    .mockImplementation(async function (this: OutputPurchaseTransport<'prepare'>) {
      const operation = (this as unknown as { operation: string }).operation
      calls.push(operation)
      let result: OutputSignedPurchaseTerms | OutputPurchaseEnvelope
      if (operation === 'prepare') {
        await server.prepare()
        const loaded = server.current()!
        let disclosed: unknown
        server.owner.store.discloseTerms(
          loaded,
          server.f.buyer,
          server.f.clock,
          server.f.guard,
          terms => {
            disclosed = terms
          }
        )
        result = parseOutputPurchaseTerms(disclosed)
      } else {
        if (operation === 'submit') await server.submit()
        else await server.recover()
        result = parseOutputPurchaseEnvelope(server.projected())
      }
      if (lost === operation) {
        lost = undefined
        throw new Error('Lost original ' + operation + ' reply')
      }
      return result as OutputSignedPurchaseTerms
    })
  async function close(owner: Awaited<ReturnType<typeof open>>) {
    await owner.buyer.stop()
    await owner.state.close()
    await owner.objects.close()
    const buyerIndex = buyers.indexOf(owner.buyer),
      storeIndex = stores.findIndex(store => store.state === owner.state)
    outputAssert(buyerIndex >= 0 && storeIndex >= 0, 'Unknown buyer fixture owner')
    buyers.splice(buyerIndex, 1)
    stores.splice(storeIndex, 1)
  }
  const dispose = async () => {
    send.mockRestore()
    await buyers.reduce((sequence, buyer) => sequence.then(() => buyer.stop()), Promise.resolve())
    await stores.reduce(
      (sequence, owner) =>
        sequence.then(async () => {
          await owner.state.close()
          await owner.objects.close()
        }),
      Promise.resolve()
    )
    await server.dispose()
    rmSync(directory, { recursive: true, force: true })
    cleanup.delete(dispose)
  }
  cleanup.add(dispose)
  return {
    server,
    partial,
    counts,
    calls,
    binding,
    directory,
    open,
    close,
    activeOwners: () => buyers.length,
    dispose,
    send: { mockRestore: () => send.mockRestore() },
    lose: (value: typeof lost) => {
      lost = value
    },
    setNow: (value: string) => {
      now = value
      server.f.setNow(value)
    },
    setAccess: (value: boolean) => {
      allowed = value
    },
    setValid: (value: boolean) => {
      valid = value
    },
    setUsable: (value: boolean) => {
      usable = value
    }
  }
}
