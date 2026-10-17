import { createHash } from 'node:crypto'
import type { WalletSnapshotTable } from '../../src/storage/snapshot/WalletReadSnapshot'
import type { SnapshotArchiveDirectory } from '../../src/storage/snapshot/archive/SnapshotArchiveDirectory'

export const now = Date.UTC(2026, 8, 30)
const identityKey = '02' + '11'.repeat(32)
export const sourceStorageIdentityKey = 'original-storage'
export const expected = { identityKey, chain: 'test' as const, sourceStorageIdentityKey }
export const tables: WalletSnapshotTable[] = [
  'provenTxs',
  'provenTxReqs',
  'outputBaskets',
  'transactions',
  'commissions',
  'outputs',
  'outputTags',
  'outputTagMaps',
  'txLabels',
  'txLabelMaps',
  'certificates',
  'certificateFields',
  'syncStates'
]
export const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')

export function fixture(extraPages = 0) {
  const binding = {
    version: 1,
    snapshotId: 'a'.repeat(64),
    sourceStorage: {
      created_at: new Date(now - 1000).toISOString(),
      updated_at: new Date(now).toISOString(),
      storageIdentityKey: sourceStorageIdentityKey,
      storageName: 'Original source',
      chain: 'test',
      dbtype: 'SQLite',
      maxOutputScript: 100000
    },
    sourceSchema: '2026-09-30-002 add snapshot archive staging',
    user: {
      created_at: new Date(now - 1000).toISOString(),
      updated_at: new Date(now).toISOString(),
      userId: 7,
      identityKey,
      activeStorage: 'historical-primary'
    }
  }
  const bindingJson = JSON.stringify(binding)
  const directory: SnapshotArchiveDirectory = {
    version: 1,
    encoding: 'wallet-snapshot-rows/1',
    archiveId: 'b'.repeat(64),
    expiresAt: now + 1000,
    pages: 13 + extraPages,
    rows: extraPages,
    digest: '',
    bindingJson,
    receipts: []
  }
  const payloads: Uint8Array[] = []
  for (const table of tables) {
    const count = table === 'provenTxs' ? extraPages + 1 : 1
    for (let page = 0; page < count; page++) {
      const bytes = new TextEncoder().encode(`${table}:${page}`)
      const done = page === count - 1
      payloads.push(bytes)
      directory.receipts.push({
        sequence: directory.receipts.length,
        table,
        rows: done ? 0 : 1,
        done,
        digest: hash(bytes)
      })
    }
  }
  rehash(directory)
  return { directory, payloads, binding }
}

export function rehash(directory: SnapshotArchiveDirectory): void {
  let previous = hash(directory.bindingJson)
  for (const page of directory.receipts)
    previous = hash(JSON.stringify([previous, page.sequence, page.table, page.rows, page.done, page.digest]))
  directory.digest = previous
}
