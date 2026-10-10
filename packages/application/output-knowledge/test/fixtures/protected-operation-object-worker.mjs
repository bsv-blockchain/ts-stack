import { createSecretKey } from 'node:crypto'
import { SQLiteProtectedOperationObjectStore } from '../../dist/operations/SQLiteProtectedOperationObjectStore.js'
import { NodeProtectedPayloadCodec } from '../../dist/private/NodeProtectedPayloadCodec.js'
const [file, config, point] = process.argv.slice(2)
const store = SQLiteProtectedOperationObjectStore.open(
  file,
  JSON.parse(config),
  new NodeProtectedPayloadCodec(
    { resolve: () => createSecretKey(Buffer.alloc(32, 85)) },
    'fixture-key'
  )
)
const id = '86'.repeat(32),
  binding = { acquisition: 'original', requestDigest: '87'.repeat(32) }
process.on('message', () => undefined)
const stop = async () => {
  process.send({ point })
  await new Promise(() => undefined)
}
if (point === 'before-reservation') await stop()
await store.reserve(id, binding, 100)
if (point === 'after-reservation' || point === 'before-delivery') await stop()
await store.put(id, binding, new Uint8Array([42, 43]))
await stop()
