import { brc38WorkingAllocation, type Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import type { Knex } from 'knex'
import {
  invalid,
  read,
  type StoredReceipt,
  type Brc38ImportJournalAdmission,
  type Brc38ImportJournalReceipt
} from './Brc38ImportJournalContract'
export * from './Brc38ImportJournalContract'

export async function load(
  k: Knex.Transaction,
  admission: Brc38ImportJournalAdmission
): Promise<StoredReceipt | undefined> {
  const rows: StoredReceipt[] = await k('brc38_import_journal')
    .where({ importId: admission.scope.importId })
    .select(
      ...['admissionJson', 'receiptJson', 'admissionSha256', 'receiptSha256', 'bindingSha256', 'archiveSha256'].map(
        field =>
          k.raw(
            "CASE WHEN typeof(??) = 'text' AND length(CAST(?? AS BLOB)) BETWEEN 1 AND ? THEN ?? ELSE NULL END AS ??",
            [field, field, field.endsWith('Sha256') ? 64 : 4096, field, field]
          )
      ),
      ...['userId', 'mappedIds', 'maximumMappedIds', 'cleanupAllowed'].map(field =>
        k.raw("CASE WHEN typeof(??) = 'integer' AND ?? BETWEEN ? AND ? THEN ?? ELSE NULL END AS ??", [
          field,
          field,
          -Number.MAX_SAFE_INTEGER,
          Number.MAX_SAFE_INTEGER,
          field,
          field
        ])
      )
    )
    .limit(2)
  if (rows.length > 1) invalid()
  return rows[0]
}

/** Temporary JSON/digest/parse allocations of one fresh journal read. The
 * result remains bounded receipt DATA; source/profile ownership and exact
 * schema must be established by the caller before entry. A resource counter
 * supplies none of that authority. Omitting it preserves legacy admission. */
export async function loadAndReadBrc38ImportJournal(
  k: Knex.Transaction,
  admission: Brc38ImportJournalAdmission,
  selectedWorking?: Brc38WorkingAllocation
): Promise<Readonly<Brc38ImportJournalReceipt>> {
  const working = brc38WorkingAllocation(selectedWorking)
  let bytes = 0
  if (working !== undefined) {
    const extents = (await k('brc38_import_journal')
      .where({ importId: admission.scope.importId })
      .select(
        k.raw(
          'length(CAST(admissionJson AS BLOB))+length(CAST(receiptJson AS BLOB))+length(CAST(admissionSha256 AS BLOB))+length(CAST(receiptSha256 AS BLOB))+length(CAST(bindingSha256 AS BLOB))+length(CAST(archiveSha256 AS BLOB)) AS bytes'
        )
      )
      .limit(2)) as Array<{ bytes: number }>
    if (
      extents.length !== 1 ||
      !Number.isSafeInteger(extents[0].bytes) ||
      extents[0].bytes < 1 ||
      extents[0].bytes > 8448
    )
      invalid()
    bytes = extents[0].bytes
  }
  const scratch = working?.claim(4096 + 16 * bytes)
  try {
    const row = await load(k, admission)
    if (row === undefined) invalid()
    return read(row, admission)
  } finally {
    scratch?.close()
  }
}
