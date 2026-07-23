import type { BdkWasmModule } from '../BdkVerifierTypes.js'
import {
  createWorkerRequestHandler,
  type BdkWorkerRequest,
  type BdkWorkerResponse
} from '../workers/BdkWorkerProtocol.js'
import BdkWorkerPool, {
  type WorkerAdapter
} from '../workers/BdkWorkerPool.js'
import BdkWorkerScheduler from '../workers/BdkWorkerScheduler.js'

class MockVector {
  push_back (_value: number): void {}
  delete (): void {}
}

function mockModule (): BdkWasmModule {
  return {
    VectorUInt8: MockVector,
    VectorInt32: MockVector,
    VectorUInt32: MockVector,
    VerifyScript: () => ({ domain: 0, code: 0 })
  }
}

describe('BDK worker warm-up', () => {
  it('does not construct a worker pool before batch warm-up', async () => {
    let poolConstructions = 0
    let terminated = 0
    const createWorker = (): WorkerAdapter => {
      let messageHandler: (response: BdkWorkerResponse) => void = () => {}
      return {
        post: (request: BdkWorkerRequest) => {
          queueMicrotask(() => {
            messageHandler({ id: request.id, result: new Uint8Array() })
          })
        },
        onMessage: handler => { messageHandler = handler },
        onError: () => {},
        terminate: () => { terminated++ }
      }
    }
    const scheduler = new BdkWorkerScheduler(() => {
      poolConstructions++
      return new BdkWorkerPool(2, createWorker)
    }, {})
    const module = mockModule()
    module.ExportVerificationTables = () => Uint8Array.of(1, 2, 3)

    expect(poolConstructions).toBe(0)
    expect(scheduler.shouldUse(250, async () => {})).toBe(false)
    expect(poolConstructions).toBe(0)
    await scheduler.preload(module)
    expect(poolConstructions).toBe(1)
    scheduler.terminate()
    expect(terminated).toBe(2)
  })

  it('imports a main-thread table snapshot instead of generating it again', async () => {
    const module = mockModule()
    const imported: Uint8Array[] = []
    let prepared = 0
    module.ImportVerificationTables = snapshot => { imported.push(snapshot) }
    module.PrepareVerification = () => { prepared++ }
    const responses: BdkWorkerResponse[] = []
    const handle = createWorkerRequestHandler(
      async () => module,
      response => { responses.push(response) }
    )
    const snapshot = Uint8Array.of(1, 2, 3)

    await handle({ id: 1, operation: 'preload', verificationTables: snapshot })

    expect(imported).toEqual([snapshot])
    expect(prepared).toBe(0)
    expect(responses).toHaveLength(1)
    expect('result' in responses[0]).toBe(true)
  })

  it('retains generation as a compatibility fallback for older BDK modules', async () => {
    const module = mockModule()
    let prepared = 0
    module.PrepareVerification = () => { prepared++ }
    const handle = createWorkerRequestHandler(async () => module, () => {})

    await handle({ id: 1, operation: 'preload' })

    expect(prepared).toBe(1)
  })
})
