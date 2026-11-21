import { deleteDB } from 'idb'
import { SHA256 } from '@bsv/sdk/primitives/Hash'
import { StorageIdb } from '../StorageIdb'
import { StorageProvider } from '../StorageProvider'
import { getPackedIdbConnection } from '../idbPackedConnection'
import { readPackedIdbCurrentMetadata } from '../idbPackedCurrentMetadata'
import { findPackedIdbMergeMetadata, type PackedIdbMergeIdentity } from '../idbPackedMergeLookup'
import { readPackedIdbClock } from '../idbPackedFields'
import { createSyncMap, type SyncMap } from '../schema/entities/EntityBase'

function same(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('Independent natural identity oracle differs')
}
async function refused(action: () => Promise<unknown>): Promise<void> {
  let failed = false
  try {
    await action()
  } catch {
    failed = true
  }
  if (!failed) throw new Error('Natural identity accepted an ambiguous or foreign destination')
}
/** Authored UNRUN actual-browser lookup component. Synthetic rows independently
 * exercise native indexes/current MVCC and profile ownership, not complete
 * entity/proof semantics or the unfinished field-aware destination. */
export async function verifyPackedIdbBoundedNaturalMergeLookup(expiresAt: number): Promise<void> {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 120000)
    throw new Error('Original finite natural lookup deadline is required')
  const monotonic = performance.now() + expiresAt - Date.now(),
    check = () => {
      if (Date.now() >= expiresAt || performance.now() >= monotonic)
        throw new Error('Original natural lookup deadline ended')
    },
    storage = new StorageIdb({
      ...StorageProvider.createStorageBaseOptions('test'),
      packed: {
        maximumLogicalBytes: 16777216,
        maximumRecords: 10000
      }
    }),
    dates = {
      created_at: new Date('2026-01-01'),
      updated_at: new Date('2026-01-01')
    },
    bytes = new Uint8Array(131089).fill(41),
    map = createSyncMap()
  storage.dbName = 'packed-natural-lookup-' + crypto.randomUUID()
  map.transaction.idMap[101] = 11
  map.output.idMap[102] = 12
  map.outputTag.idMap[103] = 13
  map.txLabel.idMap[104] = 14
  map.certificate.idMap[105] = 15
  let staged: Awaited<ReturnType<StorageIdb['beginPackedStorageField']>> | undefined
  try {
    check()
    await storage.migrate('Independent natural lookup fixture', 'target')
    staged = await storage.beginPackedStorageField({
      kind: 'typed',
      bytes: bytes.length,
      sha256: new SHA256().update(bytes).digestHex(),
      expiresAt,
      lifetimeMs: Math.max(1, expiresAt - Date.now())
    })
    for (let offset = 0; offset < bytes.length; offset += 65536)
      await staged.append(offset, bytes.subarray(offset, offset + 65536))
    const descriptor = await staged.finish()
    await storage.writeStagedStorageRow(
      'proven_txs',
      { ...dates, provenTxId: 7, txid: 'proof' },
      { rawTx: staged },
      'add'
    )
    const rows: Array<[string, Record<string, unknown>]> = [
      ['proven_tx_reqs', { provenTxReqId: 8, txid: 'request' }],
      ['output_baskets', { basketId: 9, userId: 1, name: 'basket' }],
      ['transactions', { transactionId: 11, userId: 1, txid: 'same-tx', reference: 'first-reference' }],
      ['transactions', { transactionId: 21, userId: 2, txid: 'same-tx', reference: 'foreign-reference' }],
      ['transactions', { transactionId: 31, userId: 1, txid: 'other-tx', reference: 'incoming-reference' }],
      ['outputs', { outputId: 12, userId: 1, transactionId: 11, vout: 0 }],
      ['output_tags', { outputTagId: 13, userId: 1, tag: 'tag', isDeleted: true }],
      ['tx_labels', { txLabelId: 14, userId: 1, label: 'label' }],
      ['tx_labels_map', { txLabelId: 14, transactionId: 11, isDeleted: true }],
      ['output_tags_map', { outputTagId: 13, outputId: 12 }],
      [
        'certificates',
        { certificateId: 15, userId: 1, type: 'type-a', certifier: 'certifier', serialNumber: 'serial' }
      ],
      ['certificate_fields', { certificateId: 15, userId: 1, fieldName: 'name', fieldValue: 'value' }],
      ['commissions', { commissionId: 16, userId: 1, transactionId: 11 }]
    ]
    for (const [store, row] of rows) {
      check()
      await storage.writeStagedStorageRow(store, { ...dates, ...row }, {}, 'add')
    }
    const owner = getPackedIdbConnection(storage.db!)!,
      lookup = async (selector: PackedIdbMergeIdentity, selectedMap: SyncMap = map, userId = 1, limit = 65536) => {
        const { wallet, journal: tx } = owner.operationalTransaction(['settings', ...storage.allStores], 'readonly')
        try {
          const before = await readPackedIdbClock(tx),
            result = await findPackedIdbMergeMetadata(storage, wallet, selector, userId, selectedMap, limit)
          same(await readPackedIdbClock(tx), before)
          await owner.sealOperationalEffects(wallet)
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
      cases: Array<[PackedIdbMergeIdentity, IDBValidKey]> = [
        [{ table: 'provenTxs', txid: 'proof' }, 7],
        [{ table: 'provenTxReqs', txid: 'request' }, 8],
        [{ table: 'outputBaskets', name: 'basket' }, 9],
        [{ table: 'outputTags', tag: 'tag' }, 13],
        [{ table: 'txLabels', label: 'label' }, 14],
        [{ table: 'transactions', txid: 'same-tx', reference: 'incoming-reference' }, 11],
        [{ table: 'outputs', transactionId: 101, vout: 0 }, 12],
        [{ table: 'txLabelMaps', transactionId: 101, txLabelId: 104 }, [14, 11]],
        [{ table: 'outputTagMaps', outputId: 102, outputTagId: 103 }, [13, 12]],
        [{ table: 'certificates', certifier: 'certifier', serialNumber: 'serial' }, 15],
        [{ table: 'certificateFields', certificateId: 105, fieldName: 'name' }, [15, 'name']],
        [{ table: 'commissions', transactionId: 101 }, 16]
      ]
    for (const [selector, key] of cases) {
      check()
      same((await lookup(selector))?.key, key)
    }
    const proof = await lookup({ table: 'provenTxs', txid: 'proof' }, map, 2)
    same(proof?.extents.rawTx, descriptor)
    same(proof?.fields.rawTx, undefined)
    same((await lookup({ table: 'transactions', txid: 'missing', reference: 'incoming-reference' }))?.key, 31)
    same(await lookup({ table: 'transactions', reference: 'foreign-reference' }), undefined)
    same(await lookup({ table: 'transactions', txid: '', reference: '' }), undefined)
    same((await lookup({ table: 'outputTags', tag: 'tag' }))?.fields.isDeleted, true)
    await refused(() => lookup({ table: 'provenTxs', txid: 'proof' }, map, 1, 1))
    await refused(() => lookup({ table: 'outputs', transactionId: 101, vout: -1 }))
    const missingMap = createSyncMap()
    await refused(() => lookup({ table: 'outputs', transactionId: 101, vout: 0 }, missingMap))
    const foreignMap = createSyncMap()
    foreignMap.transaction.idMap[101] = 21
    await refused(() => lookup({ table: 'outputs', transactionId: 101, vout: 0 }, foreignMap))
    await storage.writeStagedStorageRow(
      'transactions',
      { ...dates, transactionId: 32, userId: 1, txid: 'same-tx', reference: 'ambiguous' },
      {},
      'add'
    )
    await refused(() => lookup({ table: 'transactions', txid: 'same-tx', reference: 'first-reference' }))
    await storage.db!.delete('transactions', 32)
    await storage.writeStagedStorageRow(
      'certificates',
      { ...dates, certificateId: 55, userId: 1, type: 'type-b', certifier: 'certifier', serialNumber: 'serial' },
      {},
      'add'
    )
    await refused(() => lookup({ table: 'certificates', certifier: 'certifier', serialNumber: 'serial' }))
    await storage.db!.delete('certificates', 55)
    const { wallet, journal: tx } = owner.operationalTransaction(['settings', ...storage.allStores], 'readonly')
    try {
      const selector: PackedIdbMergeIdentity = { table: 'outputs', transactionId: 101, vout: 0 },
        changingMap = createSyncMap()
      changingMap.transaction.idMap[101] = 11
      const pending = findPackedIdbMergeMetadata(storage, wallet, selector, 1, changingMap, 65536)
      // Caller mutations after invocation cannot change the captured source
      // relationships or output index used by the pending native view.
      Object.assign(selector, { transactionId: 999, vout: 9 })
      changingMap.transaction.idMap[101] = 21
      same((await pending)?.key, 12)
      same((await readPackedIdbCurrentMetadata(storage, wallet, 'output_tags_map', [13, 12], 1, 65536))?.key, [13, 12])
      same(await readPackedIdbCurrentMetadata(storage, wallet, 'output_tags_map', [13, 12], 2, 65536), undefined)
      await owner.sealOperationalEffects(wallet)
      await tx.done
    } catch (cause) {
      try {
        tx.abort()
      } catch {
        /* settled */
      }
      await tx.done.catch(() => undefined)
      throw cause
    }
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
