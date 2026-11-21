import 'fake-indexeddb/auto'
import { randomUUID } from 'node:crypto'
import { deleteDB } from 'idb'
import { StorageIdb } from '../StorageIdb'
import { StorageProvider } from '../StorageProvider'
import { Brc38WorkingAllocation } from '../portable/Brc38WorkingAllocation'
import { preparePackedIdbSnapshotField } from './preparePackedIdbSnapshotField'
import type { WalletReadSnapshot, WalletSnapshotFieldReader } from './WalletReadSnapshot'

test('independent UTF8 bytes transcode through a real packed stage and release original resources', async () => {
  const storage = new StorageIdb({ ...StorageProvider.createStorageBaseOptions('test'), packed: {} }),
    text = '\ufeff' + '🙂µZ'.repeat(20000),
    raw = new TextEncoder().encode(text),
    expiresAt = Date.now() + 20000,
    working = new Brc38WorkingAllocation(4194304),
    snapshotId = 'aa'.repeat(32),
    cursor = { version: 1 as const, snapshotId, table: 'provenTxReqs' as const, after: [1] },
    reader: WalletSnapshotFieldReader = {
      readMetadataPage: jest.fn(),
      readFieldExtent: async (_table, _cursor, _field, offset, length) => raw.slice(offset, offset + length)
    },
    source = { snapshotId, expiresAt, isOpen: true, fieldReader: reader } as WalletReadSnapshot
  storage.dbName = 'packed-field-transcode-' + randomUUID()
  let prepared: Awaited<ReturnType<typeof preparePackedIdbSnapshotField>> | undefined
  try {
    await storage.migrate('Independent UTF8 component fixture', 'target')
    prepared = await preparePackedIdbSnapshotField(
      storage,
      source,
      'provenTxReqs',
      cursor,
      'history',
      { kind: 'utf8', bytes: raw.length },
      { workingAllocation: working, maximumFieldBytes: 1048576, maximumReadBytes: 8191, expiresAt }
    )
    expect(prepared.staged.descriptor.kind).toBe('utf16')
    expect(prepared.staged.descriptor.bytes).toBe(text.length * 2)
    await storage.writeStagedStorageRow(
      'proven_tx_reqs',
      {
        created_at: new Date('2026-01-01'),
        updated_at: new Date('2026-01-01'),
        provenTxReqId: 1,
        txid: '11'.repeat(32),
        status: 'completed',
        attempts: 0,
        notified: false,
        notify: '{}'
      },
      { history: prepared.staged }
    )
    expect((await storage.db!.get('proven_tx_reqs', 1))!.history).toBe(text)
    expect(working.used).toBe(4096)
  } finally {
    try {
      await prepared?.close()
    } finally {
      await storage.destroy()
      await deleteDB(storage.dbName)
      raw.fill(0)
    }
  }
  expect(working.used).toBe(0)
})

test('a changed second source pass refuses before row installation and retains no working reservation', async () => {
  const storage = new StorageIdb({ ...StorageProvider.createStorageBaseOptions('test'), packed: {} }),
    raw = new Uint8Array([1, 2, 3]),
    expiresAt = Date.now() + 20000,
    working = new Brc38WorkingAllocation(2097152),
    snapshotId = 'aa'.repeat(32),
    cursor = { version: 1 as const, snapshotId, table: 'transactions' as const, after: [1] }
  let reads = 0
  const reader: WalletSnapshotFieldReader = {
      readMetadataPage: jest.fn(),
      readFieldExtent: async () => {
        reads++
        return reads === 1 ? raw.slice() : new Uint8Array([1, 2, 4])
      }
    },
    source = { snapshotId, expiresAt, isOpen: true, fieldReader: reader } as WalletReadSnapshot
  storage.dbName = 'packed-field-replay-' + randomUUID()
  try {
    await storage.migrate('Independent replay component fixture', 'target')
    await expect(
      preparePackedIdbSnapshotField(
        storage,
        source,
        'transactions',
        cursor,
        'rawTx',
        { kind: 'binary', bytes: raw.length },
        { workingAllocation: working, maximumFieldBytes: 1024, maximumReadBytes: 8191, expiresAt }
      )
    ).rejects.toThrow('differs')
    expect(await storage.db!.count('transactions')).toBe(0)
    expect(working.used).toBe(0)
  } finally {
    await storage.destroy()
    await deleteDB(storage.dbName)
    raw.fill(0)
  }
})
