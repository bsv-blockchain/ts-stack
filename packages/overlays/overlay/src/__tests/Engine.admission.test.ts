import { Engine } from '../Engine.js'
import type { LookupService } from '../LookupService.js'
import type { TopicManager } from '../TopicManager.js'
import type { Storage } from '../storage/Storage.js'
import type {
  AdmissionCommit,
  AdmissionReceipt,
  AdmissionStorage,
  StorageScope
} from '../storage/AdmissionStorage.js'
import { getAdmissionStorage } from '../storage/AdmissionStorage.js'
import { KnexStorage } from '../storage/knex/KnexStorage.js'
import type { Knex } from 'knex'
import { Transaction, type AdmittanceInstructions } from '@bsv/sdk'

const mockChainTracker = {
  isValidRootForHeight: jest.fn(async () => true),
  currentHeight: jest.fn(async () => 800000)
}

const BRC62Hex =
  '0100beef01fe636d0c0007021400fe507c0c7aa754cef1f7889d5fd395cf1f785dd7de98eed895dbedfe4e5bc70d1502ac4e164f5bc16746bb0868404292ac8318bbac3800e4aad13a014da427adce3e010b00bc4ff395efd11719b277694cface5aa50d085a0bb81f613f70313acd28cf4557010400574b2d9142b8d28b61d88e3b2c3f44d858411356b49a28a4643b6d1a6a092a5201030051a05fc84d531b5d250c23f4f886f6812f9fe3f402d61607f977b4ecd2701c19010000fd781529d58fc2523cf396a7f25440b409857e7e221766c57214b1d38c7b481f01010062f542f45ea3660f86c013ced80534cb5fd4c19d66c56e7e8c5d4bf2d40acc5e010100b121e91836fd7cd5102b654e9f72f3cf6fdbfd0b161c53a9c54b12c841126331020100000001cd4e4cac3c7b56920d1e7655e7e260d31f29d9a388d04910f1bbd72304a79029010000006b483045022100e75279a205a547c445719420aa3138bf14743e3f42618e5f86a19bde14bb95f7022064777d34776b05d816daf1699493fcdf2ef5a5ab1ad710d9c97bfb5b8f7cef3641210263e2dee22b1ddc5e11f6fab8bcd2378bdd19580d640501ea956ec0e786f93e76ffffffff013e660000000000001976a9146bfd5c7fbe21529d45803dbcf0c87dd3c71efbc288ac0000000001000100000001ac4e164f5bc16746bb0868404292ac8318bbac3800e4aad13a014da427adce3e000000006a47304402203a61a2e931612b4bda08d541cfb980885173b8dcf64a3471238ae7abcd368d6402204cbf24f04b9aa2256d8901f0ed97866603d2be8324c2bfb7a37bf8fc90edd5b441210263e2dee22b1ddc5e11f6fab8bcd2378bdd19580d640501ea956ec0e786f93e76ffffffff013c660000000000001976a9146bfd5c7fbe21529d45803dbcf0c87dd3c71efbc288ac0000000000'

const exampleTX = Transaction.fromHexBEEF(BRC62Hex)
const exampleBeef = exampleTX.toBEEF()

const admissionScope: StorageScope = {
  network: 'testnet',
  genesisHash: '11'.repeat(32),
  nodeId: 'engine-node'
}

function receiptFor(plan: AdmissionCommit): AdmissionReceipt {
  return {
    operationId: plan.key.operationId,
    semanticDigest: plan.key.semanticDigest,
    durability: 'atomic-local',
    steak: plan.steak,
    indexes: plan.outbox
      .filter(intent => intent.kind === 'lookup')
      .map(intent => ({ target: intent.target, state: 'pending' as const })),
    propagation: plan.outbox.some(intent => intent.kind === 'propagation')
      ? 'pending'
      : 'not-requested'
  }
}

describe('Engine admission submit', () => {
  let mockTopicManager: TopicManager
  let mockLookupService: LookupService
  let mockStorage: Storage & { admission: AdmissionStorage; admissionScope: StorageScope }
  let commitAdmission: jest.Mock
  let saved: AdmissionReceipt | undefined

  beforeEach(() => {
    jest.clearAllMocks()
    saved = undefined
    mockTopicManager = {
      identifyAdmissibleOutputs: jest.fn(async (): Promise<AdmittanceInstructions> => ({
        outputsToAdmit: [0],
        coinsToRetain: []
      })),
      getDocumentation: async () => 'docs',
      getMetaData: async () => ({ name: 'Mock', shortDescription: 'Mock' })
    }
    mockLookupService = {
      outputAdmittedByTopic: jest.fn(),
      outputSpent: jest.fn(),
      lookup: jest.fn(),
      outputNoLongerRetainedInHistory: jest.fn(),
      outputEvicted: jest.fn(),
      admissionMode: 'locking-script',
      spendNotificationMode: 'none',
      getDocumentation: async () => 'docs',
      getMetaData: async () => ({ name: 'Mock', shortDescription: 'Mock' })
    }
    commitAdmission = jest.fn(async (plan: AdmissionCommit) => {
      if (saved !== undefined) return { state: 'committed' as const, receipt: saved }
      saved = receiptFor(plan)
      return { state: 'committed' as const, receipt: saved }
    })
    mockStorage = {
      admission: {
        protocol: 'overlay-admission-v1',
        commitAdmission,
        reconcileAdmission: jest.fn()
      },
      admissionScope,
      doesAppliedTransactionExist: jest.fn(async () => false),
      insertAppliedTransaction: jest.fn(),
      insertOutput: jest.fn(),
      findOutput: jest.fn(async () => null),
      findOutputsForTransaction: jest.fn(async () => []),
      markUTXOAsSpent: jest.fn(),
      updateConsumedBy: jest.fn(),
      updateTransactionBEEF: jest.fn(),
      deleteOutput: jest.fn(),
      findUTXOsForTopic: jest.fn(),
      updateLastInteraction: jest.fn(),
      getLastInteraction: jest.fn(async () => 0)
    }
  })

  test('SQL Knex storage still has no admission capability', () => {
    const knex = jest.fn() as unknown as Knex
    expect(getAdmissionStorage(new KnexStorage(knex))).toBeUndefined()
  })

  test('uses commitAdmission and does not mutate via CRUD or lookup callbacks', async () => {
    const engine = new Engine(
      { Hello: mockTopicManager },
      { Hello: mockLookupService },
      mockStorage,
      mockChainTracker
    )
    const steak = await engine.submit({ beef: exampleBeef, topics: ['Hello'] })
    expect(commitAdmission).toHaveBeenCalledTimes(1)
    expect(mockStorage.insertOutput).not.toHaveBeenCalled()
    expect(mockStorage.markUTXOAsSpent).not.toHaveBeenCalled()
    expect(mockLookupService.outputAdmittedByTopic).not.toHaveBeenCalled()
    expect(steak.Hello.outputsToAdmit).toEqual([0])
  })

  test('returns the saved STEAK after a lost admission ACK', async () => {
    const engine = new Engine(
      { Hello: mockTopicManager },
      { Hello: mockLookupService },
      mockStorage,
      mockChainTracker
    )
    const first = await engine.submit({ beef: exampleBeef, topics: ['Hello'] })
    const second = await engine.submit({ beef: exampleBeef, topics: ['Hello'] })
    expect(second).toEqual(first)
    expect(commitAdmission).toHaveBeenCalledTimes(2)
    expect(mockLookupService.outputAdmittedByTopic).not.toHaveBeenCalled()
  })

  test('historical submit omits propagation outbox', async () => {
    const engine = new Engine(
      { Hello: mockTopicManager },
      { Hello: mockLookupService },
      mockStorage,
      mockChainTracker,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        createAdvertisements: jest.fn(),
        revokeAdvertisements: jest.fn(),
        findAllAdvertisements: jest.fn(),
        parseAdvertisement: jest.fn()
      }
    )
    await engine.submit({ beef: exampleBeef, topics: ['Hello'] }, undefined, 'historical-tx')
    const plan = commitAdmission.mock.calls[0][0] as AdmissionCommit
    expect(plan.identity.mode).toBe('historical')
    expect(plan.outbox.some(intent => intent.kind === 'propagation')).toBe(false)
  })

  test('live submit with an advertiser records a pending propagation outbox', async () => {
    const engine = new Engine(
      { Hello: mockTopicManager },
      { Hello: mockLookupService },
      mockStorage,
      mockChainTracker,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        createAdvertisements: jest.fn(),
        revokeAdvertisements: jest.fn(),
        findAllAdvertisements: jest.fn(),
        parseAdvertisement: jest.fn()
      }
    )
    const onReady = jest.fn()
    const steak = await engine.submit({ beef: exampleBeef, topics: ['Hello'] }, onReady)
    const plan = commitAdmission.mock.calls[0][0] as AdmissionCommit
    expect(plan.identity.mode).toBe('live')
    expect(plan.outbox.some(intent => intent.kind === 'propagation')).toBe(true)
    expect(onReady).toHaveBeenCalledWith(steak)
  })

  test('calls onSTEAKReady only after the admission receipt', async () => {
    const order: string[] = []
    commitAdmission = jest.fn(async (plan: AdmissionCommit) => {
      order.push('commit')
      saved = receiptFor(plan)
      return { state: 'committed' as const, receipt: saved }
    })
    mockStorage.admission.commitAdmission = commitAdmission
    const engine = new Engine(
      { Hello: mockTopicManager },
      { Hello: mockLookupService },
      mockStorage,
      mockChainTracker
    )
    await engine.submit({ beef: exampleBeef, topics: ['Hello'] }, () => {
      order.push('callback')
    })
    expect(order).toEqual(['commit', 'callback'])
  })
})
