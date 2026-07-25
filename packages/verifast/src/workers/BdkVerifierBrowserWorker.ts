import createBdkModule from '../wasm/bdk-core.browser.mjs'
import {
  createWorkerRequestHandler,
  isBdkWorkerRequest,
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
  // Dedicated workers communicate through a private MessagePort. Per the HTML
  // standard these events have no cross-document origin or source.
  if (event.origin !== '' || event.source !== null) return
  if (!isBdkWorkerRequest(event.data)) return
  void handle(event.data)
}
