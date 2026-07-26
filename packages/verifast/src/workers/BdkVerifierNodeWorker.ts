import { parentPort } from 'node:worker_threads'
import createBdkModule from '../wasm/bdk-core.mjs'
import { createWorkerRequestHandler, type BdkWorkerRequest } from './BdkWorkerProtocol.js'

if (parentPort === null) throw new Error('BDK worker requires a parent port')
const port = parentPort

const handle = createWorkerRequestHandler(createBdkModule, (response, transfer) =>
  port.postMessage(response, transfer)
)
port.on('message', (request: BdkWorkerRequest) => {
  void handle(request)
})
