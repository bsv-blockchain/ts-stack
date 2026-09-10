import { Transaction } from '@bsv/sdk'
import type { LookupService } from '../LookupService.js'
import type { Output } from '../Output.js'
import {
  asStorageUint64,
  type AdmissionCommit,
  type AdmissionStorage,
  type StorageScope
} from '../storage/AdmissionStorage.js'
import {
  buildOverlayAdmissionPlan,
  getOverlayAdmissionHost,
  overlayAdmissionContextDigest,
  overlayAdmissionMode,
  overlayAdmissionOperationId,
  waitForAdmissionReceipt,
  type OverlayAdmissionHost
} from '../EngineAdmission.js'

const BRC62Hex =
  '0100beef01fe636d0c0007021400fe507c0c7aa754cef1f7889d5fd395cf1f785dd7de98eed895dbedfe4e5bc70d1502ac4e164f5bc16746bb0868404292ac8318bbac3800e4aad13a014da427adce3e010b00bc4ff395efd11719b277694cface5aa50d085a0bb81f613f70313acd28cf4557010400574b2d9142b8d28b61d88e3b2c3f44d858411356b49a28a4643b6d1a6a092a5201030051a05fc84d531b5d250c23f4f886f6812f9fe3f402d61607f977b4ecd2701c19010000fd781529d58fc2523cf396a7f25440b409857e7e221766c57214b1d38c7b481f01010062f542f45ea3660f86c013ced80534cb5fd4c19d66c56e7e8c5d4bf2d40acc5e010100b121e91836fd7cd5102b654e9f72f3cf6fdbfd0b161c53a9c54b12c841126331020100000001cd4e4cac3c7b56920d1e7655e7e260d31f29d9a388d04910f1bbd72304a79029010000006b483045022100e75279a205a547c445719420aa3138bf14743e3f42618e5f86a19bde14bb95f7022064777d34776b05d816daf1699493fcdf2ef5a5ab1ad710d9c97bfb5b8f7cef3641210263e2dee22b1ddc5e11f6fab8bcd2378bdd19580d640501ea956ec0e786f93e76ffffffff013e660000000000001976a9146bfd5c7fbe21529d45803dbcf0c87dd3c71efbc288ac0000000001000100000001ac4e164f5bc16746bb0868404292ac8318bbac3800e4aad13a014da427adce3e000000006a47304402203a61a2e931612b4bda08d541cfb980885173b8dcf64a3471238ae7abcd368d6402204cbf24f04b9aa2256d8901f0ed97866603d2be8324c2bfb7a37bf8fc90edd5b441210263e2dee22b1ddc5e11f6fab8bcd2378bdd19580d640501ea956ec0e786f93e76ffffffff013c660000000000001976a9146bfd5c7fbe21529d45803dbcf0c87dd3c71efbc288ac0000000000'

const exampleTX = Transaction.fromHexBEEF(BRC62Hex)
const exampleBeef = exampleTX.toBEEF()
const exampleTxid = exampleTX.id('hex')
const previousTxid =
  exampleTX.inputs[0].sourceTXID ?? exampleTX.inputs[0].sourceTransaction?.id('hex')
if (typeof previousTxid !== 'string')
  throw new Error('expected the example transaction to name its source')

const admissionScope: StorageScope = {
  network: 'testnet',
  genesisHash: '11'.repeat(32),
  nodeId: 'engine-node'
}

const lookupServices = { Hello: {} as LookupService }

const previousOutput: Output = {
  txid: previousTxid,
  outputIndex: exampleTX.inputs[0].sourceOutputIndex,
  outputScript: [],
  satoshis: 1,
  topic: 'Hello',
  spent: false,
  outputsConsumed: [],
  consumedBy: []
}

function host(overrides: Partial<OverlayAdmissionHost> = {}): OverlayAdmissionHost {
  return {
    admission: {
      protocol: 'overlay-admission-v1',
      commitAdmission: jest.fn(),
      reconcileAdmission: jest.fn()
    },
    admissionScope,
    ...overrides
  }
}

function validation(
  overrides: Partial<{
    topic: string
    isDupe: boolean
    previousCoins: number[]
    previousOutputs: Array<Output | null>
    outputsToAdmit: number[]
    coinsToRetain: number[]
    coinsRemoved: number[]
  }> = {}
) {
  return {
    topic: overrides.topic ?? 'Hello',
    isDupe: overrides.isDupe ?? false,
    previousCoins: overrides.previousCoins ?? [],
    previousOutputs: overrides.previousOutputs ?? [],
    admissibleOutputs: {
      outputsToAdmit: overrides.outputsToAdmit ?? [0],
      coinsToRetain: overrides.coinsToRetain ?? [],
      coinsRemoved: overrides.coinsRemoved
    }
  }
}

describe('Engine overlay admission helpers', () => {
  test('getOverlayAdmissionHost requires v1 admission and a hex genesis', () => {
    expect(getOverlayAdmissionHost(undefined)).toBeUndefined()
    expect(getOverlayAdmissionHost(null)).toBeUndefined()
    expect(getOverlayAdmissionHost({})).toBeUndefined()
    const admission = {
      protocol: 'overlay-admission-v1' as const,
      commitAdmission: jest.fn(),
      reconcileAdmission: jest.fn()
    }
    expect(getOverlayAdmissionHost({ admission })).toBeUndefined()
    expect(
      getOverlayAdmissionHost({
        admission,
        admissionScope: { ...admissionScope, genesisHash: 'zz'.repeat(32) }
      })
    ).toBeUndefined()
    expect(
      getOverlayAdmissionHost({
        admission,
        admissionScope: { network: 1, genesisHash: admissionScope.genesisHash, nodeId: 'n' }
      })
    ).toBeUndefined()
    const publishAdmissionPayload = jest.fn()
    const enlistedIndexTargets = jest.fn(() => ['Hello'])
    const getHistoryFence = jest.fn()
    const found = getOverlayAdmissionHost({
      admission,
      admissionScope,
      publishAdmissionPayload,
      enlistedIndexTargets,
      getHistoryFence
    })
    expect(found?.admission).toBe(admission)
    expect(found?.admissionScope).toEqual(admissionScope)
    expect(found?.admissionScope).not.toBe(admissionScope)
    expect(found?.publishAdmissionPayload).toBe(publishAdmissionPayload)
    expect(found?.enlistedIndexTargets).toBe(enlistedIndexTargets)
    expect(found?.getHistoryFence).toBe(getHistoryFence)
  })

  test('operation ids stay raw when short and hash when oversized or ill-formed', () => {
    const short = overlayAdmissionOperationId('live', exampleTxid, ['Hello'])
    expect(short).toBe(`submit:live:${exampleTxid}:Hello`)
    const hashed = overlayAdmissionOperationId('historical', exampleTxid, ['t'.repeat(600)])
    expect(hashed.startsWith('submit:')).toBe(true)
    expect(hashed).not.toContain('t'.repeat(600))
    expect(overlayAdmissionOperationId('live', exampleTxid, ['\ud800']).startsWith('submit:')).toBe(
      true
    )
    expect(overlayAdmissionMode('current-tx')).toBe('live')
    expect(overlayAdmissionMode('historical-tx')).toBe('historical')
    expect(overlayAdmissionMode('historical-tx-no-spv')).toBe('historical')
    expect(overlayAdmissionContextDigest()).not.toBe(overlayAdmissionContextDigest([1, 2]))
  })

  test('buildOverlayAdmissionPlan throws when no topic is accepted', async () => {
    await expect(
      buildOverlayAdmissionPlan({
        host: host(),
        tx: exampleTX,
        txid: exampleTxid,
        beef: exampleBeef,
        topics: ['Hello'],
        mode: 'live',
        validations: [validation({ outputsToAdmit: [], coinsToRetain: [] })],
        failedTopics: new Set(),
        lookupServices,
        includePropagation: true
      })
    ).rejects.toThrow('Overlay admission plan has no topics')
  })

  test('builds spends, evictions, enlisted outbox, and published payloads', async () => {
    const publishAdmissionPayload = jest.fn(async input => ({
      kind: input.kind,
      digest: overlayAdmissionContextDigest(Array.from(input.bytes)),
      byteLength: asStorageUint64(String(input.bytes.byteLength))
    }))
    const getHistoryFence = jest.fn(async () => ({
      chainEpoch: asStorageUint64('4'),
      topicHistoryGeneration: asStorageUint64('5')
    }))
    const plan = await buildOverlayAdmissionPlan({
      host: host({
        publishAdmissionPayload,
        getHistoryFence,
        enlistedIndexTargets: () => ['Hello']
      }),
      tx: exampleTX,
      txid: exampleTxid,
      beef: exampleBeef,
      topics: ['Hello'],
      mode: 'live',
      offChainValues: [9],
      validations: [
        validation({
          previousCoins: [0],
          previousOutputs: [previousOutput, null],
          coinsToRetain: [0],
          outputsToAdmit: [0, 0, 99]
        }),
        validation({ topic: 'Failed', outputsToAdmit: [0] })
      ],
      failedTopics: new Set(['Failed']),
      lookupServices: { Hello: {} as LookupService, Other: {} as LookupService },
      includePropagation: true,
      applied: {
        firstSeenHeight: 10,
        blockHeight: 11,
        blockHash: 'aa'.repeat(32),
        blockIndex: 2,
        merkleRoot: 'bb'.repeat(32)
      }
    })
    expect(plan.identity.mode).toBe('live')
    expect(plan.identity.contextDigest).toBe(overlayAdmissionContextDigest([9]))
    expect(plan.decisions).toHaveLength(1)
    expect(plan.decisions[0].expectedHistory).toEqual({
      chainEpoch: '4',
      topicHistoryGeneration: '5'
    })
    expect(plan.decisions[0].spends).toEqual([
      {
        outpoint: { txid: previousTxid, outputIndex: asStorageUint64('0') },
        expectedVersion: '1',
        spender: exampleTxid
      }
    ])
    expect(plan.decisions[0].evictions).toEqual([])
    expect(plan.decisions[0].edges).toHaveLength(2)
    expect(plan.decisions[0].outputs).toHaveLength(2)
    expect(plan.decisions[0].applied.block).toEqual({
      height: '11',
      hash: 'aa'.repeat(32),
      index: '2',
      merkleRoot: 'bb'.repeat(32)
    })
    expect(plan.outbox.some(intent => intent.target === 'Hello')).toBe(false)
    expect(plan.outbox.some(intent => intent.kind === 'propagation')).toBe(true)
    expect(publishAdmissionPayload).toHaveBeenCalled()
    expect(getHistoryFence).toHaveBeenCalledWith('Hello')
  })

  test('historical plans omit propagation and attach merkle proof metadata', async () => {
    const proven = exampleTX.inputs[0].sourceTransaction
    if (proven === undefined) throw new Error('expected a proven ancestor')
    const plan = await buildOverlayAdmissionPlan({
      host: host(),
      tx: proven,
      txid: proven.id('hex'),
      beef: proven.toBEEF(),
      topics: ['Hello'],
      mode: 'historical',
      validations: [validation({ isDupe: true, outputsToAdmit: [] })],
      failedTopics: new Set(),
      lookupServices,
      includePropagation: true
    })
    expect(plan.identity.mode).toBe('historical')
    expect(plan.outbox.some(intent => intent.kind === 'propagation')).toBe(false)
    expect(plan.decisions[0].applied.proof?.kind).toBe('merkle-path')
    expect(plan.decisions[0].applied.firstSeenHeight).toBeDefined()
  })

  test('marks unmatched previous coins stale and retains consumed coins', async () => {
    const stale = await buildOverlayAdmissionPlan({
      host: host(),
      tx: exampleTX,
      txid: exampleTxid,
      beef: exampleBeef,
      topics: ['Hello'],
      mode: 'live',
      validations: [
        validation({
          previousCoins: [0],
          previousOutputs: [previousOutput],
          coinsToRetain: []
        })
      ],
      failedTopics: new Set(),
      lookupServices,
      includePropagation: false
    })
    expect(stale.decisions[0].evictions).toEqual([
      {
        txid: previousTxid,
        outputIndex: asStorageUint64(String(exampleTX.inputs[0].sourceOutputIndex))
      }
    ])
    expect(JSON.parse(stale.steak).Hello.coinsRemoved).toEqual([0])
  })

  test('skips previous coins whose source txid cannot be recovered', async () => {
    const tx = {
      toBinary: () => exampleTX.toBinary(),
      merklePath: undefined,
      outputs: exampleTX.outputs,
      inputs: [{ sourceOutputIndex: 0 }]
    } as unknown as Transaction
    const plan = await buildOverlayAdmissionPlan({
      host: host(),
      tx,
      txid: exampleTxid,
      beef: exampleBeef,
      topics: ['Hello'],
      mode: 'live',
      validations: [validation({ previousCoins: [0], previousOutputs: [previousOutput] })],
      failedTopics: new Set(),
      lookupServices,
      includePropagation: false
    })
    expect(plan.decisions[0].evictions).toEqual([])
    expect(plan.decisions[0].edges).toEqual([])
    expect(plan.outbox.some(intent => intent.kind === 'propagation')).toBe(false)
  })
})

describe('waitForAdmissionReceipt', () => {
  const plan = {
    key: {
      scope: admissionScope,
      operationId: 'op',
      semanticDigest: 'aa'.repeat(32)
    }
  } as AdmissionCommit

  test('returns a committed result and retries a read-conflict rebuild', async () => {
    const receipt = {
      operationId: 'op',
      semanticDigest: 'aa'.repeat(32),
      durability: 'atomic-local' as const,
      steak: '{}',
      indexes: [],
      propagation: 'not-requested' as const
    }
    const admission: AdmissionStorage = {
      protocol: 'overlay-admission-v1',
      commitAdmission: jest
        .fn()
        .mockResolvedValueOnce({ state: 'rejected', code: 'read-conflict' })
        .mockResolvedValueOnce({ state: 'committed', receipt }),
      reconcileAdmission: jest.fn()
    }
    const rebuild = jest.fn(async () => plan)
    await expect(waitForAdmissionReceipt(admission, plan, rebuild)).resolves.toEqual({
      state: 'committed',
      receipt
    })
    expect(rebuild).toHaveBeenCalledTimes(1)
  })

  test('throws a non-retryable rejection and a rejected reconcile', async () => {
    await expect(
      waitForAdmissionReceipt(
        {
          protocol: 'overlay-admission-v1',
          commitAdmission: jest.fn(async () => ({ state: 'rejected', code: 'spend-conflict' })),
          reconcileAdmission: jest.fn()
        },
        plan,
        async () => plan
      )
    ).rejects.toThrow('Overlay admission rejected: spend-conflict')

    await expect(
      waitForAdmissionReceipt(
        {
          protocol: 'overlay-admission-v1',
          commitAdmission: jest.fn(async () => ({ state: 'pending', attemptId: 'a1' })),
          reconcileAdmission: jest.fn(async () => ({ state: 'rejected', code: 'invalid-plan' }))
        },
        plan,
        async () => plan
      )
    ).rejects.toThrow('Overlay admission rejected: invalid-plan')
  })

  test('reconciles a lost ack, rebuilds after abort, and times out while pending', async () => {
    const receipt = {
      operationId: 'op',
      semanticDigest: 'aa'.repeat(32),
      durability: 'atomic-local' as const,
      steak: '{}',
      indexes: [],
      propagation: 'pending' as const
    }
    await expect(
      waitForAdmissionReceipt(
        {
          protocol: 'overlay-admission-v1',
          commitAdmission: jest.fn(async () => ({ state: 'pending', attemptId: 'lost' })),
          reconcileAdmission: jest.fn(async () => ({ state: 'committed', receipt }))
        },
        plan,
        async () => plan
      )
    ).resolves.toEqual({ state: 'committed', receipt })

    const rebuild = jest.fn(async () => plan)
    await expect(
      waitForAdmissionReceipt(
        {
          protocol: 'overlay-admission-v1',
          commitAdmission: jest
            .fn()
            .mockResolvedValueOnce({ state: 'pending', attemptId: 'aborted' })
            .mockResolvedValueOnce({ state: 'committed', receipt }),
          reconcileAdmission: jest.fn(async () => ({ state: 'aborted' }))
        },
        plan,
        rebuild
      )
    ).resolves.toEqual({ state: 'committed', receipt })
    expect(rebuild).toHaveBeenCalledTimes(1)

    await expect(
      waitForAdmissionReceipt(
        {
          protocol: 'overlay-admission-v1',
          commitAdmission: jest.fn(async () => ({ state: 'pending', attemptId: 'stuck' })),
          reconcileAdmission: jest.fn(async () => ({ state: 'pending', attemptId: 'stuck' }))
        },
        plan,
        async () => plan
      )
    ).rejects.toThrow('Overlay admission commit is pending')
  })
})
