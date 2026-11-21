import { deleteDB } from 'idb'
import { StorageIdb } from '../StorageIdb'
import { StorageProvider } from '../StorageProvider'
import { getPackedIdbConnection } from '../idbPackedConnection'
import { readPackedIdbCurrentMetadata } from '../idbPackedCurrentMetadata'
import { packedIdbStores, readPackedIdbClock } from '../idbPackedFields'
import type { PackedIdbTransaction } from '../idbPackedFields'
import { SHA256 } from '@bsv/sdk/primitives/Hash'

function same(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('Independent current metadata oracle differs')
}
async function refused(action: () => Promise<unknown>): Promise<void> {
  let failed = false
  try {
    await action()
  } catch {
    failed = true
  }
  if (!failed) throw new Error('Current metadata accepted inconsistent native state')
}
/** Authored UNRUN actual-browser component case. It tests current metadata and
 * profile/MVCC consistency, not entity semantics, source authentication or the
 * unfinished occupied field-aware merge/controller. */
export async function verifyPackedIdbCurrentRowAndExtentMetadata(expiresAt: number): Promise<void> {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 120000)
    throw new Error('Original finite metadata case deadline is required')
  const monotonic = performance.now() + expiresAt - Date.now(),
    check = () => {
      if (Date.now() >= expiresAt || performance.now() >= monotonic)
        throw new Error('Original metadata case deadline ended')
    },
    storage = new StorageIdb({
      ...StorageProvider.createStorageBaseOptions('test'),
      packed: {
        maximumLogicalBytes: 16777216,
        maximumRecords: 10000
      }
    }),
    bytes = new Uint8Array(131089).fill(37),
    sha256 = new SHA256().update(bytes).digestHex(),
    dates = { created_at: new Date('2026-01-01'), updated_at: new Date('2026-01-01') }
  storage.dbName = 'packed-current-metadata-' + crypto.randomUUID()
  let staged: Awaited<ReturnType<StorageIdb['beginPackedStorageField']>> | undefined
  try {
    check()
    await storage.migrate('Independent current metadata fixture', 'target')
    staged = await storage.beginPackedStorageField({
      kind: 'typed',
      bytes: bytes.length,
      sha256,
      expiresAt,
      lifetimeMs: Math.max(1, expiresAt - Date.now())
    })
    for (let offset = 0; offset < bytes.length; offset += 65536)
      await staged.append(offset, bytes.subarray(offset, offset + 65536))
    const descriptor = await staged.finish()
    await storage.writeStagedStorageRow(
      'transactions',
      {
        ...dates,
        transactionId: 7,
        userId: 1,
        reference: 'metadata-row',
        status: 'unprocessed',
        isOutgoing: false,
        description: 'original'
      },
      { rawTx: staged },
      'add'
    )
    const owner = getPackedIdbConnection(storage.db!)!,
      inspect = async (userId = 1, limit = 65536) => {
        const { wallet, journal: tx } = owner.operationalTransaction(['settings', 'users', 'transactions'], 'readonly')
        try {
          await refused(() =>
            readPackedIdbCurrentMetadata(
              storage,
              Object.assign({}, wallet) as PackedIdbTransaction,
              'transactions',
              7,
              userId,
              limit
            )
          )
          const before = await readPackedIdbClock(tx),
            result = await readPackedIdbCurrentMetadata(storage, wallet, 'transactions', 7, userId, limit)
          same(await readPackedIdbClock(tx), before)
          await owner.sealOperationalEffects(wallet)
          await refused(() => readPackedIdbCurrentMetadata(storage, wallet, 'transactions', 7, userId, limit))
          await tx.done
          return result
        } catch (cause) {
          try {
            tx.abort()
          } catch {
            /* settled */
          }
          await tx.done.catch(() => undefined)
          throw cause
        }
      },
      initial = await inspect()
    if (initial === undefined) throw new Error('Occupied target row disappeared')
    same(initial.fields.description, 'original')
    same(initial.extents.rawTx, descriptor)
    same(initial.fields.rawTx, undefined)
    if (initial.allocationBytes > 65536 || initial.revision < 1)
      throw new Error('Metadata charge or current revision differs')
    same(await inspect(2), undefined)
    await refused(() => inspect(1, 1))
    await storage.writeStagedStorageRow(
      'transactions',
      { ...initial.fields, description: 'newer' },
      {},
      'put',
      undefined,
      { revision: initial.revision, names: ['rawTx'] }
    )
    const current = await inspect()
    if (current === undefined || current.revision <= initial.revision)
      throw new Error('Current MVCC revision did not advance')
    same(current.fields.description, 'newer')
    same(current.extents.rawTx, descriptor)
    // An actual raw corrupt version is refused before returning row metadata;
    // explicit rollback preserves the intact native row/version pair.
    const { journal: tx } = owner.operationalTransaction(['settings', 'users', 'transactions'], 'readwrite'),
      versionKey: IDBValidKey = ['transactions', 7, current.revision],
      version = await tx.objectStore(packedIdbStores.versions).get(versionKey)
    if (version === undefined || version.value === null || typeof version.value !== 'object')
      throw new Error('Current version is absent')
    await tx
      .objectStore(packedIdbStores.versions)
      .put({ ...version, value: { ...version.value, description: 'corrupt' } })
    await refused(() => readPackedIdbCurrentMetadata(storage, tx, 'transactions', 7, 1, 65536))
    tx.abort()
    await tx.done.catch(() => undefined)
    same((await inspect())?.fields.description, 'newer')
    await storage.db!.delete('transactions', 7)
    same(await inspect(), undefined)
    check()
  } finally {
    bytes.fill(0)
    try {
      await staged?.close()
      await storage.destroy()
    } finally {
      await deleteDB(storage.dbName)
    }
  }
}
