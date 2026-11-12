import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import { createOwnedNativeReadDatabase } from '../schema/ownedNativeSqliteConnectionsNode'
import { Brc38WorkingAllocation } from '../portable/Brc38WorkingAllocation'
import { Brc38StagingCleanupError } from '../portable/Brc38StagingCleanupError'
import { nativePreparedFieldsTable } from '../portable/Brc38NativePreparedFieldSchemaNode'
import { nativePackedTables } from '../portable/Brc38NativePackedSchemaNode'
import { readBrc38NativePackedDescriptor, readBrc38NativePackedExtent } from '../portable/Brc38NativePackedFieldsNode'
import type {
  PackedNativeSnapshotFieldPolicy,
  PreparedPackedNativeSnapshotField
} from './preparePackedNativeSnapshotFieldNode'
import { preparePackedNativeSnapshotField } from './preparePackedNativeSnapshotFieldNode'
import type { WalletReadSnapshot, WalletSnapshotCursor, WalletSnapshotFieldDescriptor } from './WalletReadSnapshot'

/** Authored UNRUN. A finite serial controller supplies actual factory-created
 * providers/view, a fresh NULL-script target output, source coordinates and an
 * independently generated multichunk oracle. No native executable, source
 * admission, row/primary merge policy or qualification is selected here. */
export async function verifyPackedNativeSnapshotField(
  fixture: Readonly<{
    storage: StorageKnex
    source?: WalletReadSnapshot
    cursor?: WalletSnapshotCursor
    descriptor: Readonly<WalletSnapshotFieldDescriptor>
    targetRowId: number
    expected: Uint8Array
    expiresAt: number
    prepare?: (policy: PackedNativeSnapshotFieldPolicy) => Promise<Readonly<PreparedPackedNativeSnapshotField>>
  }>
): Promise<void> {
  const { storage, source, cursor, descriptor, targetRowId, expected, expiresAt } = fixture,
    working = new Brc38WorkingAllocation(1048576),
    sha256 = createHash('sha256').update(expected).digest('hex'),
    policy = { workingAllocation: working, maximumFieldBytes: 262144, maximumReadBytes: 4096, expiresAt },
    read = async <T>(operation: (trx: Knex.Transaction) => Promise<T>): Promise<T> => {
      const database = createOwnedNativeReadDatabase(storage.knex)
      let result!: T,
        failed = false,
        cause: unknown
      try {
        result = await database.transaction(operation)
      } catch (error_) {
        failed = true
        cause = error_
      }
      try {
        await database.destroy()
      } catch (error_) {
        throw new Brc38StagingCleanupError(
          [...(failed ? [cause] : []), error_],
          'Native field case retains its reader',
          async () => {
            await database.destroy()
          }
        )
      }
      if (failed) throw cause
      return result
    },
    prepare = async () => {
      if (fixture.prepare !== undefined) return await fixture.prepare(policy)
      if (source === undefined || cursor === undefined)
        throw new Error('Actual retained source and cursor are required for the original preparation path')
      return await preparePackedNativeSnapshotField(
        storage,
        source,
        'outputs',
        cursor,
        'lockingScript',
        descriptor,
        policy
      )
    }
  if (
    !(expected instanceof Uint8Array) ||
    expected.length < 65537 ||
    expected.length > 196608 ||
    descriptor.kind !== 'binary' ||
    descriptor.bytes !== expected.length ||
    (descriptor.sha256 !== undefined && descriptor.sha256 !== sha256) ||
    !Number.isSafeInteger(targetRowId) ||
    targetRowId < 1
  )
    throw new RangeError('Independent native multichunk fixture required')
  await read(async trx => {
    if (
      (await readBrc38NativePackedDescriptor(trx, { table: 'outputs', field: 'lockingScript', rowId: targetRowId })) !==
        undefined ||
      (await trx(nativePreparedFieldsTable).first('id')) !== undefined ||
      (await trx(nativePackedTables.garbage).first('sha256')) !== undefined
    )
      throw new Error('Native field case requires a fresh drained NULL-script destination')
  })
  const interrupted = await prepare(),
    interruption = new Error('After pointer attachment, before row/checkpoint commit')
  try {
    try {
      await storage.knex.transaction(async trx => {
        await storage.writePreparedNativeSnapshotFields('outputs', targetRowId, { lockingScript: interrupted }, trx)
        throw interruption
      })
      throw new Error('Native field interruption unexpectedly committed')
    } catch (cause) {
      if (cause !== interruption) throw cause
    }
    await read(async trx => {
      if (
        (await readBrc38NativePackedDescriptor(trx, {
          table: 'outputs',
          field: 'lockingScript',
          rowId: targetRowId
        })) !== undefined
      )
        throw new Error('Rolled-back native field escaped into the wallet')
    })
    let refused = false
    try {
      await storage.knex.transaction(
        async trx =>
          await storage.writePreparedNativeSnapshotFields('outputs', targetRowId, { lockingScript: interrupted }, trx)
      )
    } catch {
      refused = true
    }
    if (!refused) throw new Error('Rolled-back preparation regained attachment authority')
    const replacement = await prepare()
    try {
      const countBefore = await read(
        async trx => await trx(nativePackedTables.chunks).where({ sha256 }).count({ count: '*' }).first()
      )
      if (replacement.descriptor.bytes !== expected.length || replacement.descriptor.sha256 !== sha256)
        throw new Error('Native preparation differs from independent fixture')
      // Independent un-attached version windows cross the physical chunk edge.
      // A zero-length read still re-enters its original lifetime/content view.
      const zero = await replacement.read(0, 0)
      try {
        if (zero.length !== 0) throw new Error('Native issued stage zero-window differs')
      } finally {
        zero.fill(0)
      }
      for (const offset of [0, 65530, expected.length - 17]) {
        const length = Math.min(17, expected.length - offset),
          actual = await replacement.read(offset, length)
        try {
          if (
            actual.length !== length ||
            !Buffer.from(actual).equals(Buffer.from(expected.subarray(offset, offset + length)))
          )
            throw new Error('Native issued stage bytes differ from independent oracle')
        } finally {
          actual.fill(0)
        }
      }
      await storage.knex.transaction(
        async trx =>
          await storage.writePreparedNativeSnapshotFields('outputs', targetRowId, { lockingScript: replacement }, trx)
      )
      await read(async trx => {
        const countAfter = await trx(nativePackedTables.chunks).where({ sha256 }).count({ count: '*' }).first()
        if (JSON.stringify(countAfter) !== JSON.stringify(countBefore))
          throw new Error('Content reuse rewrote immutable chunks')
        for (let offset = 0; offset < expected.length;) {
          const length = Math.min(32768, expected.length - offset),
            bytes = await readBrc38NativePackedExtent(trx, {
              table: 'outputs',
              field: 'lockingScript',
              rowId: targetRowId,
              offset,
              length,
              totalBytes: expected.length
            })
          try {
            for (let i = 0; i < length; i++)
              if (bytes[i] !== expected[offset + i]) throw new Error('Native destination bytes differ')
          } finally {
            bytes.fill(0)
          }
          offset += length
        }
      })
    } finally {
      await replacement.close()
    }
  } finally {
    await interrupted.close()
  }
  await read(async trx => {
    if ((await trx(nativePreparedFieldsTable).first('id')) !== undefined)
      throw new Error('Native preparation retained a lifetime after drain')
  })
  if (working.used !== 0) throw new Error('Native preparation retained its original allocation after drain')
}
