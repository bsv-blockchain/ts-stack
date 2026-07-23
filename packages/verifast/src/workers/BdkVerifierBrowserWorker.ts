import createBdkModule from '../wasm/bdk-core.browser.mjs'
import {
  createWorkerRequestHandler,
  type BdkWorkerRequest,
  type BdkWorkerResponse
} from './BdkWorkerProtocol.js'

interface BrowserWorkerScope {
  onmessage: ((event: MessageEvent<BdkWorkerRequest>) => void) | null
  postMessage: (response: BdkWorkerResponse, transfer: ArrayBuffer[]) => void
}

const scope = globalThis as typeof globalThis & BrowserWorkerScope
const handle = createWorkerRequestHandler(
  async () => await createBdkModule({
    locateFile: (path: string, prefix: string): string =>
      path.endsWith('.wasm') ? `${prefix}bdk-core.wasm` : `${prefix}${path}`
  }),
  (response, transfer) => scope.postMessage(response, transfer)
)
scope.onmessage = event => {
  void handle(event.data)
}
