import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrivateKey } from '@bsv/sdk'
import { openReferenceMongo } from './referenceMongo.js'
import { startReferenceProposalServer } from './referenceProposalServer.js'

const directory = resolve(process.env.REFERENCE_DATA ?? './reference-proposal-data'),
  create = process.env.REFERENCE_CREATE === '1',
  uri = process.env.REFERENCE_ADMISSION_URI,
  certificate = process.env.REFERENCE_TLS_CERT,
  key = process.env.REFERENCE_TLS_KEY
if (!uri || !certificate || !key)
  throw new Error('Proposal workbench requires isolated Mongo and explicit loopback TLS files')
if (create) await mkdir(directory, { recursive: true, mode: 0o700 })
const identityKey = new PrivateKey(71),
  mongo = await openReferenceMongo({
    uri,
    database: process.env.REFERENCE_ADMISSION_DATABASE ?? 'output_reference_proposals',
    identity: identityKey.toPublicKey().toString(),
    role: 'one',
    create
  })
let server: Awaited<ReturnType<typeof startReferenceProposalServer>>
try {
  server = await startReferenceProposalServer({
    path: resolve(directory, 'proposals.sqlite'),
    create,
    identityKey,
    admissionEngine: mongo.engine,
    tls: { cert: await readFile(certificate), key: await readFile(key) },
    staticDirectory: fileURLToPath(new URL('../dist', import.meta.url)),
    onFailure: () => console.error('Synthetic proposal maintenance stopped; disclosure is closed.')
  })
} catch (error) {
  await mongo.close()
  throw error
}
console.log('Synthetic private proposal workbench: ' + server.origin + '/proposal.html')
console.log(
  'Public fixture identities and synthetic chain; no real funds or production authentication.'
)
let closing: Promise<void> | undefined
const close = () => {
  closing ??= (async () => {
    try {
      await server.close()
    } finally {
      await mongo.close()
    }
  })()
  return closing
}
process.once('SIGINT', () => {
  void close()
})
process.once('SIGTERM', () => {
  void close()
})
