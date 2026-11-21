// Intended location: wallet-toolbox/test/utils/remoteSnapshotReaderFixtures.ts
import type { WalletSnapshotTable } from '../../src/storage/snapshot/WalletReadSnapshot'
import {
  snapshotArchiveReaderRequestId,
  type SnapshotArchiveReaderRequest
} from '../../src/storage/snapshot/archive/SnapshotArchiveReaderRequest'
import type { SnapshotArchiveRpcCall } from '../../src/storage/snapshot/archive/SnapshotArchiveTransport'
import { SnapshotArchiveTransport } from '../../src/storage/snapshot/archive/SnapshotArchiveTransport'
import { encodeSyncTransfer } from '../../src/storage/remoting/SyncTransfer'
import { fixture, expected, hash, rehash, tables } from './snapshotArchiveDirectoryFixtures'

export function label(id: number, text = `label-${id}`) {
  return {
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    txLabelId: id,
    userId: 7,
    label: text,
    isDeleted: id % 3 === 0
  }
}

/** Independent complete receipt chain with real binary frames and no SQL/network dependency. */
export function remoteReaderFixture(rows: object[], table: WalletSnapshotTable = 'txLabels', frameRows = 17) {
  const { directory, binding } = fixture()
  const frames: Uint8Array[] = []
  directory.receipts = []
  for (const name of tables) {
    const selected = name === table ? rows : []
    const count = Math.max(1, Math.ceil(selected.length / frameRows))
    for (let index = 0; index < count; index++) {
      const values = selected.slice(index * frameRows, (index + 1) * frameRows)
      const bytes = encodeSyncTransfer({ version: 1, table: name, rows: values })
      frames.push(bytes)
      directory.receipts.push({
        sequence: frames.length - 1,
        table: name,
        rows: values.length,
        done: index === count - 1,
        digest: hash(bytes)
      })
    }
  }
  directory.pages = frames.length
  directory.rows = rows.length
  rehash(directory)
  let request: SnapshotArchiveReaderRequest | undefined
  const receipt = () => {
    if (request === undefined) throw new Error('Fixture request has not been admitted')
    return {
      version: 1,
      requestId: request.requestId,
      expiresAt: request.notAfter,
      state: 'ready',
      archiveId: directory.archiveId,
      digest: directory.digest
    }
  }
  const response = (...[method, params]: Parameters<SnapshotArchiveRpcCall>): unknown => {
    const input = params[0] as {
      request?: SnapshotArchiveReaderRequest
      sequence?: number
      options?: { lifetimeMs: number; maxBytes: number }
    }
    switch (method) {
      case 'getSnapshotArchiveReaderOffer': {
        const serverTime = Date.now()
        const fields = {
          version: 2 as const,
          nonce: 'a'.repeat(64),
          notAfter: serverTime + input.options!.lifetimeMs,
          maxBytes: input.options!.maxBytes
        }
        request = { ...fields, requestId: snapshotArchiveReaderRequestId(fields) }
        directory.expiresAt = request.notAfter
        return {
          version: 1,
          outcome: 'offered',
          request,
          offer: {
            version: 1,
            serverTime,
            sourceStorageIdentityKey: expected.sourceStorageIdentityKey,
            sourceSchema: binding.sourceSchema,
            chain: 'test'
          }
        }
      }
      case 'admitSnapshotArchive':
        if (input.request?.requestId !== request?.requestId) throw new Error('Fixture request was not offered')
        return { version: 1, outcome: 'accepted', receipt: receipt() }
      case 'getSnapshotArchiveStatus':
        return receipt()
      case 'getSnapshotArchiveDirectory':
        return directory
      case 'readSnapshotArchivePage': {
        const sequence = input.sequence!
        return { ...directory.receipts[sequence], bytes: frames[sequence] }
      }
      case 'cancelSnapshotArchiveRequest':
        return true
      default:
        throw new Error(`Unexpected fixture operation ${method}`)
    }
  }
  const implementation: SnapshotArchiveRpcCall = (method, params) => {
    try {
      return Promise.resolve(response(method, params))
    } catch (error) {
      return Promise.reject(error)
    }
  }
  const rpc = jest.fn(implementation)
  const transport = new SnapshotArchiveTransport(
    rpc,
    expected.identityKey,
    expected.sourceStorageIdentityKey,
    'test',
    true
  )
  return { transport, rpc, frames, directory, binding, receipt }
}
