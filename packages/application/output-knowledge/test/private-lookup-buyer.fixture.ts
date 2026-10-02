import { fixturePromise } from './private-async.fixture.js'
import { afterEach } from '@jest/globals'
import { createSecretKey } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CompletedProtoWallet, PrivateKey, type OutputCapabilityRecoveryRequest } from '@bsv/sdk'
import { SQLiteOperationStateStore } from '../src/operations/SQLiteOperationStateStore.js'
import {
  ProtectedOperationStateStore,
  protectedOperationBinding,
  PROTECTED_OPERATION_INITIAL
} from '../src/operations/ProtectedOperationStateStore.js'
import { SQLiteProtectedOperationObjectStore } from '../src/operations/SQLiteProtectedOperationObjectStore.js'
import { NodeProtectedPayloadCodec } from '../src/private/NodeProtectedPayloadCodec.js'
import {
  PrivateLookupBuyer,
  privateLookupBuyerBinding,
  PRIVATE_LOOKUP_BUYER_INITIAL,
  type PrivateLookupBuyerOptions
} from '../src/private/PrivateLookupBuyer.js'
import { custody } from './protected-operation-object.fixture.js'
import { acquisitionRecordFixture } from './private-acquisition-records.fixture.js'
const cleanup = new Set<() => Promise<void>>()
afterEach(async () => {
  for await (const close of cleanup) await close()
  cleanup.clear()
})
export async function buyerFixture(overrides: Partial<PrivateLookupBuyerOptions> = {}) {
  const f = await acquisitionRecordFixture(),
    directory = mkdtempSync(join(tmpdir(), 'durable-buyer-')),
    codec = custody(),
    objectCodec = new NodeProtectedPayloadCodec(
      { resolve: () => createSecretKey(Buffer.alloc(32, 84)) },
      'fixture'
    ),
    trust: OutputCapabilityRecoveryRequest = {
      ...f.trust,
      baseURL: f.installation.baseURL,
      identity: f.f.seller,
      chain: f.f.chain,
      service: f.f.request.service,
      kind: 'lookup',
      profile: f.body.services[0].profiles[0].id
    },
    original = {
      contract: f.quote.capability,
      request: f.f.request,
      derivationSuffix: f.f.payment().derivationSuffix
    }
  let finalized = false,
    allowed = true,
    now = '20',
    usable = true,
    valid = true
  const counts = { preflight: 0, plan: 0, finish: 0, recover: 0, verify: 0, usable: 0 }
  const payment: PrivateLookupBuyerOptions['payment'] = {
    configuration: { protocol: 'synthetic-durable-payment', wallet: f.f.buyer, storage: 'fixture' },
    plan(id, challenge, suffix) {
      return fixturePromise(() => {
        counts.plan++
        return { operationId: id, acquisitionId: challenge.acquisitionId, suffix }
      })
    },
    recover() {
      return fixturePromise(() => {
        counts.recover++
        return finalized ? { state: 'finalized', payment: f.f.payment() } : { state: 'absent' }
      })
    },
    finish(_plan, guard) {
      return fixturePromise(() => {
        guard()
        counts.finish++
        finalized = true
        return f.f.payment()
      })
    }
  }
  const validation: PrivateLookupBuyerOptions['validation'] = {
    id: 'urn:test:buyer-material',
    preflight() {
      return fixturePromise(() => {
        counts.preflight++
        if (!valid) throw new Error('Synthetic domain terms are invalid')
      })
    },
    verify() {
      return fixturePromise(() => {
        counts.verify++
        if (!valid) throw new Error('Synthetic material is invalid')
      })
    },
    usable() {
      return fixturePromise(() => {
        counts.usable++
        return usable
      })
    }
  }
  const partial = {
      original,
      trust,
      payment,
      validation,
      wallet: new CompletedProtoWallet(new PrivateKey(84)),
      clock: () => now,
      current: () => allowed,
      ...overrides
    },
    binding = privateLookupBuyerBinding(partial),
    protectedOptions = { binding, maximumValueBytes: 16384 },
    stateBinding = protectedOperationBinding(protectedOptions, codec),
    objectConfiguration = {
      storeId: '94'.repeat(32),
      recipient: f.f.buyer,
      binding,
      maximumObjects: 5,
      maximumObjectBytes: 1048576
    }
  const stores: {
      state: ProtectedOperationStateStore
      objects: SQLiteProtectedOperationObjectStore
    }[] = [],
    buyers: PrivateLookupBuyer[] = []
  async function open(create = false) {
    const base = create
      ? SQLiteOperationStateStore.create(
          join(directory, 'state.sqlite'),
          'buyer',
          stateBinding,
          PROTECTED_OPERATION_INITIAL
        )
      : SQLiteOperationStateStore.open(join(directory, 'state.sqlite'), 'buyer', stateBinding)
    const state = create
      ? await ProtectedOperationStateStore.initialize(
          base,
          codec,
          protectedOptions,
          PRIVATE_LOOKUP_BUYER_INITIAL
        )
      : await ProtectedOperationStateStore.open(base, codec, protectedOptions)
    const objects = SQLiteProtectedOperationObjectStore[create ? 'create' : 'open'](
      join(directory, 'objects.sqlite'),
      objectConfiguration,
      objectCodec
    )
    const ports = { ...partial, state, objects }
    stores.push({ state, objects })
    const buyer = await PrivateLookupBuyer[create ? 'initialize' : 'open'](ports)
    buyers.push(buyer)
    return { buyer, ports, state, objects }
  }
  const dispose = async () => {
    for await (const buyer of buyers) await buyer.stop()
    for await (const owner of stores) {
      await owner.state.close()
      await owner.objects.close()
    }
    rmSync(directory, { recursive: true, force: true })
    cleanup.delete(dispose)
  }
  cleanup.add(dispose)
  return {
    f,
    directory,
    counts,
    partial,
    binding,
    open,
    dispose,
    setNow: (value: string) => {
      now = value
    },
    setAccess: (value: boolean) => {
      allowed = value
    },
    setUsable: (value: boolean) => {
      usable = value
    },
    setValid: (value: boolean) => {
      valid = value
    },
    finalized: () => finalized
  }
}
