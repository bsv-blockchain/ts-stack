import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalOutputJSON } from '@bsv/sdk'
import {
  AuthorDocumentPolicy,
  ProposalPolicyRegistry,
  ProposalTransitions
} from '../../dist/proposals/index.js'
import { SQLiteProposalJournal } from '../../dist/proposals/SQLiteProposalJournal.js'

const settings = JSON.parse(readFileSync(join(process.cwd(), 'worker.json'), 'utf8'))
const registry = new ProposalPolicyRegistry([
  { policy: new AuthorDocumentPolicy(), parameters: { maxTextBytes: 32 } }
])
const lifecycle = new ProposalTransitions(registry, settings.scope, {
  maxLifetimeSeconds: '100',
  futureSkewSeconds: '2'
})
const journal = new SQLiteProposalJournal(settings.file, 'send-test', settings.identity, lifecycle)
try {
  await journal.enqueueResponse(
    { reference: settings.reference, bytes: new Uint8Array([1, 2, 3]) },
    entry => canonicalOutputJSON(entry?.transition.next) === settings.record,
    bytes => {
      process.send({ kind: 'enqueued', bytes: Array.from(bytes) })
      const pause = new Int32Array(new SharedArrayBuffer(4))
      const release = join(process.cwd(), 'release')
      // Bounded synchronous hold, allowing another process to attempt the writer
      // lock while this process is still inside the actual enqueue callback.
      for (let attempt = 0; attempt < 500 && !existsSync(release); attempt += 1)
        Atomics.wait(pause, 0, 0, 10)
      if (!existsSync(release)) throw new Error('Proposal send test gate deadline')
      return undefined
    }
  )
} finally {
  await journal.close()
}
process.disconnect()
