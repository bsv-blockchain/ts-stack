import { parentPort } from 'node:worker_threads'
import createBdkModule from '../src/wasm/bdk-core.mjs'

if (parentPort === null) throw new Error('warm-up benchmark requires a parent port')

const bdk = await createBdkModule()
parentPort.postMessage('loaded')
parentPort.on('message', snapshot => {
  if (snapshot === null) bdk.PrepareVerification()
  else bdk.ImportVerificationTables(snapshot)
  parentPort.postMessage('ready')
})
