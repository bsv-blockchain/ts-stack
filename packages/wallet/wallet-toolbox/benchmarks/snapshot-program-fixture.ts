import { promiseFromSync } from '../src/utility/promiseFromSync'
import { MerklePath, Script, Transaction } from '@bsv/sdk'
import { SHA256 } from '@bsv/sdk/primitives/Hash'
import type { WalletServices } from '../src/sdk/WalletServices.interfaces'
import type { StorageKnex } from '../src/storage/StorageKnex'
import { semanticStageFixture } from '../src/storage/portable/Brc38SemanticStageFixture'
import { decodePortableRow } from '../src/storage/portable/Brc38PortableRows'
import { brc38ImportRowForm, brc38ImportTableOrder } from '../src/storage/portable/Brc38ImportForms'

import type { SnapshotMeasurementCase } from './snapshot-measurement-cases'
export { snapshotMeasurementCases, type SnapshotMeasurementCase } from './snapshot-measurement-cases'
const stores = {
  provenTxs: 'proven_txs',
  provenTxReqs: 'proven_tx_reqs',
  outputBaskets: 'output_baskets',
  transactions: 'transactions',
  commissions: 'commissions',
  outputs: 'outputs',
  outputTags: 'output_tags',
  outputTagMaps: 'output_tags_map',
  txLabels: 'tx_labels',
  txLabelMaps: 'tx_labels_map',
  certificates: 'certificates',
  certificateFields: 'certificate_fields',
  syncStates: 'sync_states'
} as const

/** Independent synthetic all-thirteen-table dataset. The fixed header oracle
 * proves protocol/record fidelity only; it is never a live-chain/funded proof.
 * Seeding is serial and outside every measured interval. */
export async function seedSnapshotMeasurement(
  storage: StorageKnex,
  identityKey: string,
  shape: SnapshotMeasurementCase
) {
  const data = semanticStageFixture(),
    { user } = await storage.findOrInsertUser(identityKey),
    settings = await storage.readSettings(),
    tx = new Transaction()
  tx.addOutput({ satoshis: 1, lockingScript: Script.fromASM(`OP_FALSE OP_RETURN ${'31'.repeat(shape.rawBytes)}`) })
  const txid = tx.id('hex'),
    raw = Buffer.from(tx.toBinary()),
    merkle = Buffer.from(new MerklePath(100, [[{ offset: 0, hash: txid, txid: true }]]).toBinary()),
    header = new Uint8Array(80)
  new DataView(header.buffer).setUint32(0, 1, true)
  header.set(Buffer.from(txid, 'hex').reverse(), 36)
  const blockHash = Buffer.from(new SHA256().update(new SHA256().update(header).digest()).digest())
    .reverse()
    .toString('hex')
  data.user.identityKey = identityKey
  data.user.userId = user.userId
  data.user.activeStorage = settings.storageIdentityKey
  for (const rows of Object.values(data.tables))
    for (const row of rows) {
      if ('userId' in row) row.userId = user.userId
      if ('txid' in row) row.txid = txid
    }
  Object.assign(data.tables.provenTxs[0], {
    height: 100,
    index: 0,
    blockHash,
    merkleRoot: txid,
    rawTx: raw.toString('base64'),
    merklePath: merkle.toString('base64')
  })
  data.tables.transactions[0].rawTx = raw.toString('base64')
  data.tables.provenTxReqs[0].rawTx = raw.toString('base64')
  data.tables.provenTxReqs[0].history = {
    notes: [{ when: data.exportedAt, what: 'measurement history', detail: 'x'.repeat(shape.historyCharacters) }]
  }
  // The fixed existing notify relationship maps transaction 14. No unknown
  // reference is needed to establish a performance measurement.
  data.tables.provenTxReqs[0].notify = { transactionIds: [14] }
  await storage.knex.transaction(async transaction => {
    await transaction('output_baskets').where({ userId: user.userId }).del()
    for (const table of brc38ImportTableOrder)
      for (const portable of data.tables[table]) {
        const decoded = decodePortableRow<Record<string, unknown>>(brc38ImportRowForm(table).kind, portable),
          row: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(decoded))
          row[key] =
            value instanceof Date
              ? value.toISOString()
              : typeof value === 'boolean'
                ? Number(value)
                : Array.isArray(value)
                  ? Buffer.from(value)
                  : value
        await transaction(stores[table]).insert(row)
      }
    for (let index = 0; index < shape.labels; index++)
      await storage.insertTxLabel(
        {
          txLabelId: 0,
          userId: user.userId,
          label: `measurement-${String(index).padStart(6, '0')}`,
          isDeleted: index % 97 === 0,
          created_at: new Date(data.exportedAt),
          updated_at: new Date(data.exportedAt)
        },
        transaction
      )
  })
  await storage.updateUser(user.userId, { activeStorage: settings.storageIdentityKey })
  const services = {
    getChainTracker: () =>
      promiseFromSync(() => ({
        isValidRootForHeight: (root: string, height: number) => promiseFromSync(() => root === txid && height === 100)
      })),
    getHeaderForHeight: (height: number) => {
      return promiseFromSync(() => {
        if (height !== 100) throw new Error('Measurement requested a different independent header')
        return Array.from(header)
      })
    }
  } as unknown as WalletServices
  // Avoid starting unrelated backfill/service tasks in a measurement fixture.
  // Both actual storage actors still run their complete proof validation.
  Object.defineProperty(storage, 'getServices', { value: () => services })
  return {
    user,
    txid,
    raw,
    services,
    history: data.tables.provenTxReqs[0].history,
    labelCount: shape.labels + 1,
    sourceIdentity: settings.storageIdentityKey
  }
}
