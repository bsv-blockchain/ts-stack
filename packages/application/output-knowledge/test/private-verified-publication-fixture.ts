import { afterEach } from '@jest/globals'
import { createSecretKey } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PrivateServiceDomain } from '../src/private/PrivateServiceDomain.js'
import { NodeProtectedPayloadCodec } from '../src/private/NodeProtectedPayloadCodec.js'
import { SQLitePrivatePublicationStore } from '../src/private/SQLitePrivatePublicationStore.js'
import { contractFixture } from './private-publication-service-fixture.js'
import { config, limits, allow } from './private-publication-fixture.js'

const cleanups = new Set<() => void>()
afterEach(() => {
  for (const cleanup of cleanups) cleanup()
  cleanups.clear()
})
export function verifiedFixture(payloads?: NodeProtectedPayloadCodec) {
  const contract = contractFixture(),
    configuration = config()
  configuration.identity = {
    chain: contract.installation.chain,
    seller: contract.installation.seller
  }
  const directory = mkdtempSync(join(tmpdir(), 'private-verified-publication-')),
    path = join(directory, 'private.db')
  const owners: PrivateServiceDomain[] = []
  const domain = (create: boolean) => {
    const owner = PrivateServiceDomain[create ? 'create' : 'open'](
      path,
      configuration,
      { resolve: () => createSecretKey(Buffer.alloc(32, 101)) },
      payloads ??
        new NodeProtectedPayloadCodec(
          { resolve: () => createSecretKey(Buffer.alloc(32, 102)) },
          'payload'
        )
    )
    owners.push(owner)
    return owner
  }
  const owner = domain(true)
  const cleanup = () => {
    for (const retained of owners) retained.close()
    rmSync(directory, { recursive: true, force: true })
    cleanups.delete(cleanup)
  }
  cleanups.add(cleanup)
  const native = {
    owner,
    path,
    store: new SQLitePrivatePublicationStore(owner, limits()),
    rows() {
      const database = new DatabaseSync(path)
      try {
        return database.prepare('SELECT kind,key FROM protected_records ORDER BY kind,key').all()
      } finally {
        database.close()
      }
    }
  }
  const service = {
    contracts: contract.contracts,
    validationPolicy: contract.policy,
    lookup: contract.prepared.fence.state.lookup,
    maximumBindingBytes: 8192,
    maximumOutcomeBytes: 4096
  }
  const store = new SQLitePrivatePublicationStore(owner, limits(), service)
  const selected = {
    publisher: contract.prepared.fence.state.publisher,
    lookup: service.lookup
  }
  const stage = () =>
    store.stageVerified(contract.request, selected, '30', contract.record, () => '20', allow)
  return {
    cleanup,
    contract,
    configuration,
    native,
    service,
    store,
    selected,
    stage,
    reopen() {
      return new SQLitePrivatePublicationStore(domain(false), limits(), service)
    },
    reopenWithDomain() {
      const owner = domain(false)
      return { owner, store: new SQLitePrivatePublicationStore(owner, limits(), service) }
    }
  }
}
