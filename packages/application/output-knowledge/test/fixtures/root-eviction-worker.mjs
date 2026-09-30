import { existsSync, readFileSync } from 'node:fs'
import { SQLiteRootEvictionStore } from '../../dist/root-eviction/SQLiteRootEvictionStore.js'

const setup = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const store = SQLiteRootEvictionStore.open(setup.path, setup.configuration)
try {
  if (setup.mode === 'queue') {
    await store.enqueue(
      { revision: setup.revision, targets: [setup.target], bytes: new Uint8Array([1, 2, 3]) },
      () => true,
      bytes => {
        // IPC is the actual transport queue in this component-level test. HTTP
        // middleware and delivery adapters require their own qualification.
        process.send({ kind: 'queued', bytes: Array.from(bytes) })
        const deadline = Date.now() + 10000
        while (!existsSync(setup.release)) {
          if (Date.now() >= deadline) throw new Error('Parent did not release the root gate')
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
        }
      }
    )
  } else if (setup.mode === 'decision') {
    await store.evaluate(setup.evaluation)
    process.send({ kind: 'committed' })
    // The parent kills this process after observing the durable boundary.
    await new Promise(resolve => setTimeout(resolve, 10000))
  } else if (setup.mode === 'projection') {
    await store.projected(setup.intent)
    process.send({ kind: 'committed' })
    await new Promise(resolve => setTimeout(resolve, 10000))
  } else throw new Error('Unknown root fixture mode')
} finally {
  await store.close()
  process.disconnect()
}
