import type { BdkWasmModule } from '../BdkVerifierTypes.js'
import {
  createWorkerRequestHandler,
  isBdkWorkerRequest,
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

describe('BDK worker protocol validation', () => {
  it('accepts each supported request shape', () => {
    expect(isBdkWorkerRequest({
      id: 0,
      operation: 'preload',
      verificationTables: new Uint8Array()
    })).toBe(true)
    expect(isBdkWorkerRequest({
      id: 1,
      operation: 'verifyScripts',
      payload: {
        extendedTransactions: new Uint8Array(),
        transactionOffsets: new Uint32Array(),
        utxoHeights: new Int32Array(),
        heightOffsets: new Uint32Array(),
        blockHeights: new Int32Array(),
        consensus: new Uint8Array(),
        customFlags: new Uint32Array(),
        customFlagOffsets: new Uint32Array(),
        network: 0
      }
    })).toBe(true)
    expect(isBdkWorkerRequest({
      id: 2,
      operation: 'verifySpends',
      payload: {
        transactions: new Uint8Array(),
        transactionOffsets: new Uint32Array(),
        inputIndices: new Uint32Array(),
        lockingScripts: new Uint8Array(),
        lockingScriptOffsets: new Uint32Array(),
        sourceSatoshis: new Float64Array(),
        utxoHeights: new Int32Array(),
        blockHeights: new Int32Array(),
        consensus: new Uint8Array(),
        hasCustomFlags: new Uint8Array(),
        customFlags: new Uint32Array(),
        network: 5
      }
    })).toBe(true)
    expect(isBdkWorkerRequest({
      id: 3,
      operation: 'verifyDigests',
      payload: {
        publicKeys: new Uint8Array(),
        publicKeyOffsets: new Uint32Array(),
        digests: new Uint8Array(),
        signatures: new Uint8Array(),
        signatureOffsets: new Uint32Array()
      }
    })).toBe(true)
  })

  it.each([
    null,
    { id: -1, operation: 'preload' },
    { id: 1.5, operation: 'preload' },
    { id: 1, operation: 'unknown' },
    { id: 1, operation: 'preload', verificationTables: [] },
    { id: 1, operation: 'verifyDigests', payload: {} },
    {
      id: 1,
      operation: 'verifyScripts',
      payload: {
        extendedTransactions: new Uint8Array(),
        transactionOffsets: new Uint32Array(),
        utxoHeights: new Int32Array(),
        heightOffsets: new Uint32Array(),
        blockHeights: new Int32Array(),
        consensus: new Uint8Array(),
        customFlags: new Uint32Array(),
        customFlagOffsets: new Uint32Array(),
        network: 6
      }
    }
  ])('rejects malformed request data: %p', value => {
    expect(isBdkWorkerRequest(value)).toBe(false)
  })
})

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
        onExit: () => {},
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

  it('retries module creation in a worker after a transient load failure', async () => {
    const responses: BdkWorkerResponse[] = []
    let attempts = 0
    const handle = createWorkerRequestHandler(
      async () => {
        attempts++
        if (attempts === 1) throw new Error('transient load failure')
        return mockModule()
      },
      response => { responses.push(response) }
    )

    await handle({ id: 1, operation: 'preload' })
    await handle({ id: 2, operation: 'preload' })

    expect(responses[0]).toEqual({ id: 1, error: 'transient load failure' })
    expect('result' in responses[1]).toBe(true)
    expect(attempts).toBe(2)
  })

  it('rejects in-flight work when a worker exits and does not hang', async () => {
    let exit: (error: Error) => void = () => {}
    const worker = (): WorkerAdapter => ({
      post: () => {},
      onMessage: () => {},
      onError: () => {},
      onExit: handler => { exit = handler },
      terminate: () => {}
    })
    const pool = new BdkWorkerPool(1, worker)
    const pending = pool.execute([{
      operation: 'verifyDigests',
      payload: {
        publicKeys: new Uint8Array(),
        publicKeyOffsets: new Uint32Array(),
        digests: new Uint8Array(),
        signatures: new Uint8Array(),
        signatureOffsets: new Uint32Array()
      }
    }])
    exit(new Error('worker exited'))
    await expect(pending).rejects.toThrow('worker exited')
  })

  it('processes more requests than workers in ordered waves', async () => {
    let nextResult = 0
    const createWorker = (): WorkerAdapter => {
      let messageHandler: (response: BdkWorkerResponse) => void = () => {}
      return {
        post: request => {
          const result = Uint8Array.of(nextResult++)
          queueMicrotask(() => { messageHandler({ id: request.id, result }) })
        },
        onMessage: handler => { messageHandler = handler },
        onError: () => {},
        onExit: () => {},
        terminate: () => {}
      }
    }
    const pool = new BdkWorkerPool(2, createWorker)
    const request = {
      operation: 'preload' as const
    }
    const results = await pool.execute([request, request, request, request, request])
    expect(results.map(result => result[0])).toEqual([0, 1, 2, 3, 4])
  })

  it('recreates the pool after transient startup failure', async () => {
    let constructions = 0
    const scheduler = new BdkWorkerScheduler(onFailure => {
      constructions++
      const fail = constructions === 1
      const createWorker = (): WorkerAdapter => {
        let messageHandler: (response: BdkWorkerResponse) => void = () => {}
        return {
          post: request => {
            queueMicrotask(() => {
              messageHandler(fail
                ? { id: request.id, error: 'startup failed' }
                : { id: request.id, result: new Uint8Array() })
            })
          },
          onMessage: handler => { messageHandler = handler },
          onError: () => {},
          onExit: () => {},
          terminate: () => {}
        }
      }
      return new BdkWorkerPool(2, createWorker, onFailure)
    }, {})

    await expect(scheduler.preload(mockModule())).rejects.toThrow('startup failed')
    await expect(scheduler.preload(mockModule())).resolves.toBeUndefined()
    expect(constructions).toBe(2)
  })

  it('keeps worker chunking enabled beyond one pool-capacity wave', async () => {
    const createWorker = (): WorkerAdapter => {
      let messageHandler: (response: BdkWorkerResponse) => void = () => {}
      return {
        post: request => {
          queueMicrotask(() => {
            messageHandler({ id: request.id, result: new Uint8Array() })
          })
        },
        onMessage: handler => { messageHandler = handler },
        onError: () => {},
        onExit: () => {},
        terminate: () => {}
      }
    }
    const scheduler = new BdkWorkerScheduler(
      onFailure => new BdkWorkerPool(2, createWorker, onFailure),
      { maxBatchItems: 2 }
    )
    await scheduler.preload(mockModule())
    const items = [0, 1, 2, 3, 4]
    const chunks = scheduler.parallelChunks(items, () => 1)
    expect(chunks).toHaveLength(3)
    expect(chunks.flat()).toEqual(items)
  })

  it('places an item above the byte target in its own worker chunk', async () => {
    const scheduler = new BdkWorkerScheduler(
      onFailure => new BdkWorkerPool(2, () => {
        let messageHandler: (response: BdkWorkerResponse) => void = () => {}
        return {
          post: request => {
            queueMicrotask(() => {
              messageHandler({ id: request.id, result: new Uint8Array() })
            })
          },
          onMessage: handler => { messageHandler = handler },
          onError: () => {},
          onExit: () => {},
          terminate: () => {}
        }
      }, onFailure),
      { maxBatchBytes: 1 }
    )
    await scheduler.preload(mockModule())

    expect(scheduler.parallelChunks([0, 1], item => item === 0 ? 2 : 1))
      .toEqual([[0], [1]])
  })
})
