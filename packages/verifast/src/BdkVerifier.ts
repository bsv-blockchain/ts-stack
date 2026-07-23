import createBdkModule from './wasm/bdk-core.mjs'
import { availableParallelism } from 'node:os'
import { Worker as NodeWorker } from 'node:worker_threads'
import BdkVerifierCore, {
  type BdkVerifierOptions,
  type BdkWasmFactory
} from './BdkVerifierCore.js'
import BdkWorkerPool, { type WorkerAdapter } from './workers/BdkWorkerPool.js'
import BdkWorkerScheduler from './workers/BdkWorkerScheduler.js'
import type {
  BdkWorkerRequest,
  BdkWorkerResponse
} from './workers/BdkWorkerProtocol.js'

export * from './BdkVerifierCore.js'

function createNodeWorker (): WorkerAdapter {
  const worker = new NodeWorker(
    new URL('./workers/BdkVerifierNodeWorker.js', import.meta.url)
  )
  let activeRequests = 0
  worker.unref()
  return {
    post: (request: BdkWorkerRequest, transfer: ArrayBuffer[]) => {
      activeRequests++
      worker.ref()
      try {
        worker.postMessage(request, transfer)
      } catch (error) {
        activeRequests--
        if (activeRequests === 0) worker.unref()
        throw error
      }
    },
    onMessage: handler => {
      worker.on('message', (response: BdkWorkerResponse) => {
        if (activeRequests > 0) activeRequests--
        if (activeRequests === 0) worker.unref()
        handler(response)
      })
    },
    onError: handler => {
      worker.on('error', error => {
        activeRequests = 0
        worker.unref()
        handler(error instanceof Error ? error : new Error(String(error)))
      })
    },
    onExit: handler => {
      worker.on('exit', code => {
        activeRequests = 0
        handler(new Error(`BDK worker exited unexpectedly with code ${code}`))
      })
    },
    terminate: () => { void worker.terminate() }
  }
}

function createNodeWorkerPool (
  options: BdkVerifierOptions
): BdkWorkerScheduler | undefined {
  if (
    options.batchWorkers !== undefined &&
    (!Number.isSafeInteger(options.batchWorkers) ||
      options.batchWorkers < 1 ||
      options.batchWorkers > 16)
  ) {
    throw new RangeError('batchWorkers must be a safe integer from 1 to 16')
  }
  const workerCount = options.batchWorkers ??
    Math.max(1, Math.min(4, Math.floor(availableParallelism() / 4)))
  if (workerCount <= 1) return undefined
  return new BdkWorkerScheduler(
    onFailure => new BdkWorkerPool(workerCount, createNodeWorker, onFailure),
    options
  )
}

/** Node.js BDK verifier using the Node-only Emscripten loader. */
export default class BdkVerifier extends BdkVerifierCore {
  constructor (factoryOrOptions: BdkWasmFactory | BdkVerifierOptions = {}, options: BdkVerifierOptions = {}) {
    if (typeof factoryOrOptions === 'function') {
      super(factoryOrOptions, options)
    } else {
      super(
        createBdkModule,
        factoryOrOptions,
        createNodeWorkerPool(factoryOrOptions)
      )
    }
  }
}
