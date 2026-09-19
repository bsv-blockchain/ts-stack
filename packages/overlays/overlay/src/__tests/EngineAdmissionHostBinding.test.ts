import type {
  AdmissionPayloadRef,
  AdmissionStorage,
  HistoryFence,
  StorageScope
} from '../storage/AdmissionStorage'
import { getOverlayAdmissionHost } from '../EngineAdmission'

// Storage adapters are classes whose optional host methods read instance state.
// The host object must call them on the adapter, not as detached functions.
class InstanceStateStorage {
  public readonly admissionScope: StorageScope = {
    network: 'testnet',
    genesisHash: '11'.repeat(32),
    nodeId: 'binding-node'
  }

  public readonly admission: AdmissionStorage
  private readonly published: string[] = []
  private readonly targets = ['ls_example']
  private readonly fence: HistoryFence = { chainEpoch: '7', topicHistoryGeneration: '3' }

  constructor(admission: AdmissionStorage) {
    this.admission = admission
  }

  async publishAdmissionPayload(input: {
    kind: AdmissionPayloadRef['kind']
    bytes: Uint8Array
  }): Promise<AdmissionPayloadRef> {
    this.published.push(input.kind)
    return { kind: input.kind, digest: 'ab'.repeat(32), byteLength: String(input.bytes.byteLength) }
  }

  enlistedIndexTargets(): readonly string[] {
    return this.targets
  }

  async getHistoryFence(): Promise<HistoryFence> {
    return this.fence
  }

  publishedKinds(): readonly string[] {
    return this.published
  }
}

const admission = {
  protocol: 'overlay-admission-v1',
  commitAdmission: jest.fn(),
  reconcileAdmission: jest.fn()
} as unknown as AdmissionStorage

describe('getOverlayAdmissionHost', () => {
  it('invokes optional host methods on the storage instance', async () => {
    const storage = new InstanceStateStorage(admission)
    const host = getOverlayAdmissionHost(storage)
    expect(host).toBeDefined()

    const ref = await host?.publishAdmissionPayload?.({
      kind: 'raw-tx',
      bytes: Uint8Array.of(1, 2, 3)
    })
    expect(ref).toEqual({ kind: 'raw-tx', digest: 'ab'.repeat(32), byteLength: '3' })
    expect(storage.publishedKinds()).toEqual(['raw-tx'])
    expect(host?.enlistedIndexTargets?.()).toEqual(['ls_example'])
    await expect(host?.getHistoryFence?.('tm_example')).resolves.toEqual({
      chainEpoch: '7',
      topicHistoryGeneration: '3'
    })
  })

  it('leaves host methods undefined when the storage does not provide them', () => {
    const host = getOverlayAdmissionHost({
      admission,
      admissionScope: new InstanceStateStorage(admission).admissionScope
    })
    expect(host).toBeDefined()
    expect(host?.publishAdmissionPayload).toBeUndefined()
    expect(host?.enlistedIndexTargets).toBeUndefined()
    expect(host?.getHistoryFence).toBeUndefined()
  })
})
