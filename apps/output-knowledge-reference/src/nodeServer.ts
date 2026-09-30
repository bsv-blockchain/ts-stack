import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrivateKey } from '@bsv/sdk'
import { startReferenceServer } from './referenceServer.js'

const role = process.env.REFERENCE_HOST ?? 'one'
if (!['one', 'two'].includes(role)) throw new Error('REFERENCE_HOST must be one or two')
const first = role === 'one'
const port = first ? 4174 : 4175
const directory = resolve(process.env.REFERENCE_DATA ?? './reference-data', role)
const create = process.env.REFERENCE_CREATE === '1'
if (create) await mkdir(directory, { recursive: true, mode: 0o700 })
const remotePort = first ? 4175 : 4174
const server = await startReferenceServer({
  path: resolve(directory, 'provider.sqlite'),
  create,
  id: role,
  port,
  identityKey: new PrivateKey(first ? 71 : 72),
  allowedOrigins: ['http://127.0.0.1:' + remotePort],
  peers: [
    {
      id: first ? 'two' : 'one',
      baseURL: 'http://127.0.0.1:' + remotePort + '/api',
      identity: new PrivateKey(first ? 72 : 71).toPublicKey().toString()
    }
  ],
  staticDirectory: fileURLToPath(new URL('../dist', import.meta.url))
})
console.log('Synthetic output-knowledge workbench: ' + server.origin)
console.log(
  'Public fixture keys and synthetic chain only. No real funds or production authentication.'
)
let closing = false
async function close() {
  if (closing) return
  closing = true
  await server.close()
}
process.once('SIGINT', () => {
  void close()
})
process.once('SIGTERM', () => {
  void close()
})
