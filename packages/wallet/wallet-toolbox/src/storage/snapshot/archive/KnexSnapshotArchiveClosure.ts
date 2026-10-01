import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../../sdk/WERR_errors'
import { runInSeries } from '../../../utility/runInSeries'
import { walletSnapshotSourceQuery } from '../KnexWalletReadSnapshot'
import type { WalletSnapshotTable } from '../WalletReadSnapshot'

interface Reference {
  table: WalletSnapshotTable
  source: string
  field: string
  target: string
  key: string
  profile: boolean
  optional?: boolean
}

// Use exactly the same selected rows as the page reader. Global proofs are
// included only through this profile's transactions or proof requests.
const references: readonly Reference[] = [
  {
    table: 'transactions',
    source: 'transactions',
    field: 'provenTxId',
    target: 'proven_txs',
    key: 'provenTxId',
    profile: false,
    optional: true
  },
  {
    table: 'provenTxReqs',
    source: 'proven_tx_reqs',
    field: 'provenTxId',
    target: 'proven_txs',
    key: 'provenTxId',
    profile: false,
    optional: true
  },
  {
    table: 'commissions',
    source: 'commissions',
    field: 'transactionId',
    target: 'transactions',
    key: 'transactionId',
    profile: true
  },
  {
    table: 'outputs',
    source: 'outputs',
    field: 'transactionId',
    target: 'transactions',
    key: 'transactionId',
    profile: true
  },
  {
    table: 'outputs',
    source: 'outputs',
    field: 'basketId',
    target: 'output_baskets',
    key: 'basketId',
    profile: true,
    optional: true
  },
  {
    table: 'outputs',
    source: 'outputs',
    field: 'spentBy',
    target: 'transactions',
    key: 'transactionId',
    profile: true,
    optional: true
  },
  {
    table: 'txLabelMaps',
    source: 'tx_labels_map',
    field: 'transactionId',
    target: 'transactions',
    key: 'transactionId',
    profile: true
  },
  {
    table: 'txLabelMaps',
    source: 'tx_labels_map',
    field: 'txLabelId',
    target: 'tx_labels',
    key: 'txLabelId',
    profile: true
  },
  {
    table: 'outputTagMaps',
    source: 'output_tags_map',
    field: 'outputId',
    target: 'outputs',
    key: 'outputId',
    profile: true
  },
  {
    table: 'outputTagMaps',
    source: 'output_tags_map',
    field: 'outputTagId',
    target: 'output_tags',
    key: 'outputTagId',
    profile: true
  },
  {
    table: 'certificateFields',
    source: 'certificate_fields',
    field: 'certificateId',
    target: 'certificates',
    key: 'certificateId',
    profile: true
  },
  {
    table: 'certificateFields',
    source: 'certificate_fields',
    field: 'userId',
    target: 'users',
    key: 'userId',
    profile: true
  }
]

/**
 * Check relational closure in the caller's retained read transaction. Only a
 * constant marker is returned for an invalid relation; blobs and full ID maps
 * are never loaded. This does not parse or authenticate BRC-38/39 documents.
 */
export async function assertKnexSnapshotArchiveClosure(
  k: Knex,
  userId: number,
  profileIndexes = false,
  relationIndexes = false,
  certificateIndexes = false
): Promise<void> {
  if (!Number.isSafeInteger(userId) || userId < 1) throw new WERR_INVALID_PARAMETER('userId', 'a positive safe ID')
  await runInSeries(references, async reference => {
    const column = `${reference.source}.${reference.field}`
    const target = k(reference.target)
      .select(k.raw('1'))
      .whereRaw('?? = ??', [`${reference.target}.${reference.key}`, column])
    if (reference.profile) void target.where(`${reference.target}.userId`, userId)
    const invalid = walletSnapshotSourceQuery(
      k,
      reference.table,
      userId,
      profileIndexes,
      relationIndexes,
      certificateIndexes
    )
      .select(k.raw('1 AS invalid'))
      .whereNotExists(target)
    if (reference.optional === true) void invalid.whereNotNull(column)
    if ((await invalid.first()) !== undefined) {
      throw new WERR_INVALID_OPERATION('Snapshot source contains an incomplete or cross-profile relation')
    }
  })
}
