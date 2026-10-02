import { afterEach } from '@jest/globals'
import { createSecretKey } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQLiteProtectedLedger } from '../src/private/SQLiteProtectedLedger.js'
import { NodeProtectedPayloadCodec } from '../src/private/NodeProtectedPayloadCodec.js'
import type {
  ProtectedLedgerConfiguration,
  ProtectedLedgerAddress,
  ProtectedLedgerChange
} from '../src/private/ProtectedLedgerCodec.js'

export const key = createSecretKey(Buffer.alloc(32, 19))
export const configuration: ProtectedLedgerConfiguration = {
  storeId: 'ab'.repeat(32),
  binding: { service: 'synthetic-private-service', chain: 'test-only' },
  maximumRecords: 16,
  maximumReservedBytes: 8192,
  maximumRecordBytes: 1024
}
export const custody = { resolve: () => key }
export const codec = () => new NodeProtectedPayloadCodec(custody, 'fixture-key')
export const address = (index = 1): ProtectedLedgerAddress => ({
  kind: 'publication',
  key: index.toString(16).padStart(64, '0')
})
export const change = (
  index = 1,
  value = { secret: 'synthetic-material' },
  reservedBytes = 128
): ProtectedLedgerChange => ({
  ...address(index),
  expectedRevision: null,
  reservedBytes,
  reservedUpdates: 4,
  value
})
export const authorize = () => {}
export const clock = () => '100'
const cleanups = new Set<() => void>()
afterEach(() => {
  for (const cleanup of cleanups) cleanup()
  cleanups.clear()
})
export function fixture(config = configuration, payloads = codec()) {
  const directory = mkdtempSync(join(tmpdir(), 'private-ledger-test-')),
    path = join(directory, 'ledger.db')
  const ledger = SQLiteProtectedLedger.create(path, config, payloads)
  const owners = [ledger]
  const cleanup = () => {
    for (const owner of owners) owner.close()
    rmSync(directory, { recursive: true, force: true })
    cleanups.delete(cleanup)
  }
  cleanups.add(cleanup)
  return {
    ledger,
    path,
    directory,
    cleanup,
    reopen(next = payloads) {
      const owner = SQLiteProtectedLedger.open(path, config, next)
      owners.push(owner)
      return owner
    }
  }
}
