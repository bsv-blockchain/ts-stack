import { afterEach } from '@jest/globals'
import { createSecretKey } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PrivateKey } from '@bsv/sdk'
import {
  PrivateServiceDomain,
  type PrivateServiceDomainConfiguration
} from '../src/private/PrivateServiceDomain.js'
import { NodeProtectedPayloadCodec } from '../src/private/NodeProtectedPayloadCodec.js'
import { SQLitePrivatePublicationStore } from '../src/private/SQLitePrivatePublicationStore.js'
import {
  privatePublicationOperation,
  type PrivatePublicationProgress
} from '../src/private/PrivatePublicationProgress.js'

const indexKey = createSecretKey(Buffer.alloc(32, 101)),
  payloadKey = createSecretKey(Buffer.alloc(32, 102))
export const selected = () => ({
  publisher: new PrivateKey(1).toPublicKey().toString(),
  lookup: { service: 'ls_synthetic', rulesDigest: '22'.repeat(32) }
})
export const config = (): PrivateServiceDomainConfiguration => ({
  identity: {
    seller: selected().publisher,
    chain: { network: 'main', genesisHash: '11'.repeat(32) }
  },
  indexKeyId: 'index',
  capacity: {
    storeId: 'ab'.repeat(32),
    maximumRecords: 16,
    maximumReservedBytes: 1024 * 1024,
    maximumRecordBytes: 131072
  },
  application: { profile: 'synthetic-publication-test/1' }
})
export const request = () => ({
  version: 1,
  requestId: 'synthetic-publish-1',
  topic: 'tm_synthetic',
  evidence: { txid: '33'.repeat(32), outputIndex: 1, beef: 'AQ==' },
  assetId: '44'.repeat(32),
  schema: 'urn:synthetic:private:1',
  privateValues: 'Ag=='
})
export const limits = () => ({
  maximumBlobBytes: 4096,
  maximumFenceBytes: 131072,
  supportedExtensions: []
})
export const allow = () => {}
export const clock = () => '10'
const cleanups = new Set<() => void>()
afterEach(() => {
  for (const close of cleanups) close()
  cleanups.clear()
})
export function fixture(configuration = config()) {
  const directory = mkdtempSync(join(tmpdir(), 'private-publication-test-')),
    path = join(directory, 'private.db')
  const owners: PrivateServiceDomain[] = []
  const domain = (create: boolean) => {
    const owner = PrivateServiceDomain[create ? 'create' : 'open'](
      path,
      configuration,
      { resolve: () => indexKey },
      new NodeProtectedPayloadCodec({ resolve: () => payloadKey }, 'payload')
    )
    owners.push(owner)
    return owner
  }
  const owner = domain(true),
    store = new SQLitePrivatePublicationStore(owner, limits())
  const cleanup = () => {
    for (const item of owners) item.close()
    rmSync(directory, { recursive: true, force: true })
    cleanups.delete(cleanup)
  }
  cleanups.add(cleanup)
  return {
    owner,
    store,
    path,
    cleanup,
    reopen() {
      return new SQLitePrivatePublicationStore(domain(false), limits())
    },
    rows() {
      const db = new DatabaseSync(path)
      try {
        return db.prepare('SELECT kind,key FROM protected_records ORDER BY kind,key').all()
      } finally {
        db.close()
      }
    }
  }
}
export const staged = (store: SQLitePrivatePublicationStore) =>
  store.stage(request(), selected(), '20', clock, allow)
export const admission = (state: PrivatePublicationProgress) => ({
  operationId: privatePublicationOperation(state),
  txid: state.txid,
  assessmentContextId: 'synthetic-context',
  steak: { tm_synthetic: { outputsToAdmit: [1], coinsToRetain: [] } }
})
export const binding = (state: PrivatePublicationProgress) => ({
  publicationId: state.publicationId,
  requestDigest: state.requestDigest,
  blobKey: state.blobKey,
  ...state.lookup,
  receiptDigest: '55'.repeat(32)
})
