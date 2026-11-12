import { utf16CodeUnitAt } from '../../utility/utf16CodeUnitAt'
import { deleteDB } from 'idb'
import { StorageIdb } from '../StorageIdb'
import { StorageProvider } from '../StorageProvider'
import type { TableCertificate, TableCertificateField, TableTransaction } from '../schema/tables'
import type { WalletReadSnapshot, WalletSnapshotCursor, WalletSnapshotFieldDescriptor } from './WalletReadSnapshot'
import { openPackedIdbSyncSource } from './openPackedIdbSyncSource'
import { preparePackedIdbSnapshotField } from './preparePackedIdbSnapshotField'
import { Brc38WorkingAllocation } from '../portable/Brc38WorkingAllocation'

// Authored UNRUN. The native controller must supply an original finite
// deadline and a current compiled browser artifact. The Jest importer uses an
// emulated database and cannot establish native browser qualification.
function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('Independent retained field-source oracle differs')
}
async function refused(run: () => Promise<unknown>): Promise<void> {
  let failed = false
  try {
    await run()
  } catch {
    failed = true
  }
  if (!failed) throw new Error('Field source admitted an invalid coordinate or stale owner')
}
function utf16(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length * 2),
    view = new DataView(bytes.buffer)
  for (let index = 0; index < value.length; index++) view.setUint16(index * 2, utf16CodeUnitAt(value, index), true)
  return bytes
}
function exact(actual: Uint8Array, expected: Uint8Array): void {
  if (actual.length !== expected.length || actual.some((byte, index) => byte !== expected[index]))
    throw new Error('Independent extent byte oracle differs')
}

/** Field-aware replica ordering, retained revisions, exact windows and current
 * primary checks. No destination merge, authentication or activation claim. */
export async function verifyPackedIdbReplicaFieldOrderingAndRetainedExtents(expiresAt: number): Promise<void> {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 120000)
    throw new Error('An original finite field-source case deadline is required')
  const monotonicDeadline = performance.now() + expiresAt - Date.now(),
    check = () => {
      if (Date.now() >= expiresAt || performance.now() >= monotonicDeadline)
        throw new Error('Field-source case deadline reached')
    },
    storage = new StorageIdb({
      ...StorageProvider.createStorageBaseOptions('test'),
      packed: { maximumLogicalBytes: 16777216, maximumRecords: 10000 }
    }),
    identityKey = '02' + '11'.repeat(32),
    timestamps = { created_at: new Date('2026-01-01'), updated_at: new Date('2026-01-01') },
    rawTx = Array.from({ length: 150001 }, (_, index) => index % 251),
    text = 'A'.repeat(40000) + '\ud800' + 'B'.repeat(40000),
    field = (certificateId: number, fieldName: string, fieldValue: string): TableCertificateField => ({
      ...timestamps,
      userId: 1,
      certificateId,
      fieldName,
      fieldValue,
      masterKey: 'a2V5'
    }),
    certificate = (certificateId: number): TableCertificate => ({
      ...timestamps,
      certificateId,
      userId: 1,
      type: 'dHlwZQ==',
      serialNumber: `serial-${certificateId}`,
      certifier: identityKey,
      subject: identityKey,
      revocationOutpoint: '11'.repeat(32) + '.0',
      signature: '22'.repeat(32),
      isDeleted: false
    }),
    transaction: TableTransaction = {
      ...timestamps,
      transactionId: 1,
      userId: 1,
      txid: '33'.repeat(32),
      reference: 'field-source',
      status: 'completed',
      isOutgoing: true,
      satoshis: 0,
      description: 'Synthetic',
      rawTx
    }
  storage.dbName = `packed-field-source-${crypto.randomUUID()}`
  let source: WalletReadSnapshot | undefined
  try {
    check()
    await storage.migrate('Synthetic field-source case', 'field-source-store')
    check()
    await storage.db!.put('users', { ...timestamps, userId: 1, identityKey, activeStorage: 'field-source-store' })
    await storage.db!.put('certificates', certificate(1))
    await storage.db!.put('certificates', certificate(2))
    await storage.db!.put('certificate_fields', field(1, 'zeta', 'later'))
    await storage.db!.put('certificate_fields', field(2, 'alpha', text))
    await storage.db!.put('transactions', transaction)
    check()
    source = await openPackedIdbSyncSource(storage, identityKey, { lifetimeMs: expiresAt - Date.now() })
    const reader = source.fieldReader
    if (reader === undefined) throw new Error('Genuine field reader missing')
    const first = await reader.readMetadataPage('certificateFields', undefined, { maxRows: 1, maxBytes: 8192 })
    equal(
      first.rows.map(row => [row.fields.fieldName, row.fields.certificateId]),
      [['alpha', 2]]
    )
    equal(first.cursor!.after, ['alpha', 2])
    equal(first.rows[0].cursor.snapshotId, source.snapshotId)
    equal(first.rows[0].fields.fieldValue, undefined)
    equal(first.rows[0].extents.fieldValue.kind, 'utf16le')
    if (first.payloadBytes > 8192) throw new Error('Selected metadata budget was exceeded')
    const firstCursor: WalletSnapshotCursor = { ...first.rows[0].cursor, after: [...first.rows[0].cursor.after] },
      descriptor: WalletSnapshotFieldDescriptor = { ...first.rows[0].extents.fieldValue },
      expectedText = utf16(text)
    // A completed foreground update while the view remains open proves that
    // this source did not retain its previous readonly transaction.
    await storage.db!.put('certificate_fields', field(2, 'alpha', 'changed after ceiling'))
    for (const [offset, length] of [
      [0, 65536],
      [65535, 65536],
      [131071, expectedText.length - 131071],
      [expectedText.length, 0]
    ]) {
      check()
      exact(
        await reader.readFieldExtent('certificateFields', firstCursor, 'fieldValue', offset, length, descriptor),
        expectedText.slice(offset, offset + length)
      )
    }
    await refused(() => reader.readFieldExtent('certificateFields', firstCursor, 'fieldValue', 0, 65537, descriptor))
    await refused(() =>
      reader.readFieldExtent('certificateFields', firstCursor, 'fieldValue', 0, 1, {
        ...descriptor,
        bytes: descriptor.bytes + 2
      })
    )
    await refused(() =>
      reader.readFieldExtent(
        'certificateFields',
        { ...firstCursor, snapshotId: 'ff'.repeat(32) },
        'fieldValue',
        0,
        1,
        descriptor
      )
    )
    await refused(() =>
      reader.readFieldExtent(
        'certificateFields',
        { ...firstCursor, after: [2, 'alpha'] },
        'fieldValue',
        0,
        1,
        descriptor
      )
    )
    const second = await reader.readMetadataPage('certificateFields', first.cursor, { maxRows: 1, maxBytes: 8192 })
    equal(
      second.rows.map(row => [row.fields.fieldName, row.fields.certificateId]),
      [['zeta', 1]]
    )
    equal((await reader.readMetadataPage('certificateFields', second.cursor)).rows, [])
    // Full row pagination must use the same replica order, including retry.
    const hydrated = await source.readPage('certificateFields', undefined, { maxRows: 1, maxBytes: 1048576 })
    equal(hydrated.rows[0].fieldValue, text)
    equal(hydrated.cursor!.after, ['alpha', 2])
    equal((await source.readPage('certificateFields', hydrated.cursor, { maxRows: 1 })).rows[0].fieldName, 'zeta')
    const native = await storage.openWalletReadSnapshot(identityKey, { lifetimeMs: expiresAt - Date.now() })
    try {
      equal(
        (await native.readPage('certificateFields', undefined, { maxRows: 1, order: 'portable' })).rows[0].fieldName,
        'zeta'
      )
    } finally {
      await native.close()
    }
    const binary = await reader.readMetadataPage('transactions', undefined, { maxRows: 1000, maxBytes: 8192 })
    equal(binary.rows[0].fields.rawTx, undefined)
    equal(binary.rows[0].extents.rawTx.kind, 'binary')
    equal(binary.rows[0].extents.rawTx.bytes, rawTx.length)
    for (const offset of [0, 65535, 131070]) {
      check()
      const length = Math.min(65536, rawTx.length - offset)
      exact(
        await reader.readFieldExtent(
          'transactions',
          binary.rows[0].cursor,
          'rawTx',
          offset,
          length,
          binary.rows[0].extents.rawTx
        ),
        new Uint8Array(rawTx.slice(offset, offset + length))
      )
    }
    const working = new Brc38WorkingAllocation(4194304),
      policy = {
        workingAllocation: working,
        maximumFieldBytes: 1048576,
        maximumReadBytes: 8191,
        expiresAt: source.expiresAt
      },
      transferredBinary = await preparePackedIdbSnapshotField(
        storage,
        source,
        'transactions',
        binary.rows[0].cursor,
        'rawTx',
        binary.rows[0].extents.rawTx,
        policy
      )
    let transferredText: Awaited<ReturnType<typeof preparePackedIdbSnapshotField>> | undefined
    try {
      transferredText = await preparePackedIdbSnapshotField(
        storage,
        source,
        'certificateFields',
        firstCursor,
        'fieldValue',
        descriptor,
        policy
      )
      equal(working.used, 8192)
      const { rawTx: _rawTx, ...transactionMetadata } = { ...transaction, transactionId: 2, reference: 'transferred' },
        { fieldValue: _fieldValue, ...textMetadata } = field(2, 'alpha', '')
      const writer = storage.db!.transaction(['transactions', 'certificate_fields'], 'readwrite')
      await storage.writeStagedStorageRow(
        'transactions',
        transactionMetadata,
        { rawTx: transferredBinary.staged },
        'add',
        writer
      )
      await storage.writeStagedStorageRow(
        'certificate_fields',
        textMetadata,
        { fieldValue: transferredText.staged },
        'put',
        writer
      )
      await writer.done
      exact((await storage.db!.get('transactions', 2))!.rawTx as Uint8Array, new Uint8Array(rawTx))
      equal((await storage.db!.get('certificate_fields', [2, 'alpha']))!.fieldValue, text)
    } finally {
      try {
        await transferredText?.close()
      } finally {
        await transferredBinary.close()
      }
    }
    equal(working.used, 0)
    await refused(() =>
      preparePackedIdbSnapshotField(storage, source!, 'certificateFields', firstCursor, 'fieldValue', descriptor, {
        ...policy,
        workingAllocation: new Brc38WorkingAllocation(8192)
      })
    )
    equal(working.used, 0)
    const pending = reader.readMetadataPage('transactions', undefined, { maxRows: 1, maxBytes: 8192 })
    try {
      await refused(() =>
        reader.readFieldExtent('transactions', binary.rows[0].cursor, 'rawTx', 0, 1, binary.rows[0].extents.rawTx)
      )
      await refused(() => source!.readPage('transactions'))
    } finally {
      await pending
    }
    await storage.db!.put('users', { ...timestamps, userId: 1, identityKey, activeStorage: 'away' })
    await storage.db!.put('users', { ...timestamps, userId: 1, identityKey, activeStorage: 'field-source-store' })
    await refused(() =>
      reader.readFieldExtent('transactions', binary.rows[0].cursor, 'rawTx', 0, 1, binary.rows[0].extents.rawTx)
    )
    await refused(() => reader.readMetadataPage('transactions'))
    check()
  } finally {
    try {
      await source?.close()
    } finally {
      try {
        await storage.destroy()
      } finally {
        await deleteDB(storage.dbName)
      }
    }
  }
}
