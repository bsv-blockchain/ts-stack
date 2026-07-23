import createBdkModule from './wasm/bdk-core.browser.mjs'
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

const createBundledModule: BdkWasmFactory = async () => await createBdkModule({
  locateFile: (path: string, prefix: string): string =>
    path.endsWith('.wasm') ? `${prefix}bdk-core.wasm` : `${prefix}${path}`
})

function createBrowserWorker (): WorkerAdapter {
  const worker = new Worker(
    new URL('./workers/BdkVerifierBrowserWorker.js', import.meta.url),
    { type: 'module' }
  )
  return {
    post: (request: BdkWorkerRequest, transfer: ArrayBuffer[]) => {
      worker.postMessage(request, transfer)
    },
    onMessage: handler => {
      worker.onmessage = event => handler(event.data as BdkWorkerResponse)
    },
    onError: handler => {
      worker.onerror = event => handler(new Error(event.message))
    },
    onExit: () => {},
    terminate: () => { worker.terminate() }
  }
}

function createBrowserWorkerPool (
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
  if (typeof Worker === 'undefined') return undefined
  const logicalCores = globalThis.navigator?.hardwareConcurrency ?? 1
  const workerCount = options.batchWorkers ??
    Math.max(1, Math.min(4, Math.floor(logicalCores / 4)))
  if (workerCount <= 1) return undefined
  return new BdkWorkerScheduler(
    onFailure => new BdkWorkerPool(workerCount, createBrowserWorker, onFailure),
    options
  )
}

/** Browser/worker BDK verifier using glue with no Node imports. */
export default class BdkVerifier extends BdkVerifierCore {
  constructor (factoryOrOptions: BdkWasmFactory | BdkVerifierOptions = {}, options: BdkVerifierOptions = {}) {
    if (typeof factoryOrOptions === 'function') {
      super(factoryOrOptions, options)
    } else {
      super(
        createBundledModule,
        factoryOrOptions,
        createBrowserWorkerPool(factoryOrOptions)
      )
    }
  }
}
