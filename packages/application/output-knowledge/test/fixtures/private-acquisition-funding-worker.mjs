import { fixtureJob } from './private-acquisition-worker-input.mjs'
import { createSecretKey } from 'node:crypto'
import { PrivateServiceDomain } from '../../dist/private/PrivateServiceDomain.js'
import { NodeProtectedPayloadCodec } from '../../dist/private/NodeProtectedPayloadCodec.js'
import { PrivateAcquisitionFundingIndex } from '../../dist/private/PrivateAcquisitionFundingIndex.js'

// Public synthetic custody for this isolated test database only.
const input = await fixtureJob('acquisition-index-')
const owner = PrivateServiceDomain.open(
  input.path,
  input.config,
  { resolve: () => createSecretKey(Buffer.alloc(32, 91)) },
  new NodeProtectedPayloadCodec({ resolve: () => createSecretKey(Buffer.alloc(32, 92)) }, 'payload')
)
const clock = () => '30',
  allow = () => {}
try {
  const revision = owner.ledger.enumerate('funding-fence', null, 1, clock, allow).revision
  const change = new PrivateAcquisitionFundingIndex(owner).assign(
    input.state,
    revision,
    clock,
    allow
  )
  if (change === null) throw new Error('Fixture unexpectedly already assigned')
  process.once('message', message => {
    try {
      if (message !== 'commit') throw new Error('Unknown fixture command')
      try {
        owner.ledger.commit(revision, [change], clock, allow)
        process.send({ phase: 'settled', outcome: 'committed' })
      } catch (error) {
        if (error.code !== 'conflict') throw error
        process.send({ phase: 'settled', outcome: 'conflict' })
      }
    } catch {
      process.send({ phase: 'settled', outcome: 'unexpected-failure' })
      process.exitCode = 1
    } finally {
      owner.close()
      process.disconnect()
    }
  })
  process.send({ phase: 'ready', revision })
} catch {
  owner.close()
  process.exitCode = 1
  process.disconnect()
}
