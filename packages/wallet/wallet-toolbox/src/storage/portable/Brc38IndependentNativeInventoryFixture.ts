import type { Knex } from 'knex'
import { createHash } from 'node:crypto'
import type { Brc38NativeLocalBaselineTable } from './Brc38NativeLocalBaselineTables'
import type { IndependentLocalCandidateRow } from './Brc38PrivateLocalCandidateNode.case'
import type { Brc38NativePriorImportTable } from './Brc38NativePriorImportTables'

// Independent fixture vocabulary. Do not import the production reader's field
// list, point inventory, image producer, candidate or merge policy here.
const tables = [
  'users',
  'settings',
  'proven_txs',
  'proven_tx_reqs',
  'output_baskets',
  'output_tags',
  'tx_labels',
  'transactions',
  'outputs',
  'commissions',
  'tx_labels_map',
  'output_tags_map',
  'certificates',
  'certificate_fields',
  'sync_states',
  'monitor_events',
  'prepared_beef_metadata',
  'prepared_beefs',
  'action_batches',
  'action_batch_outputs',
  'action_batch_blobs',
  'sync_transfers',
  'sync_transfer_parts',
  'auth_sessions',
  'auth_message_nonces',
  'payment_replays',
  'snapshot_sync_sessions',
  'snapshot_sync_ids',
  'snapshot_sync_primary_epochs',
  'snapshot_reconciliation_windows',
  'snapshot_reconciliation_stage_budgets',
  'snapshot_reconciliation_stage_pages',
  'snapshot_reconciliation_stage_chains',
  'snapshot_reconciliation_promotion_cursors',
  'snapshot_reconciliation_captured_identity_budgets',
  'snapshot_reconciliation_captured_identities',
  'snapshot_reconciliation_identity_frames',
  'snapshot_reconciliation_identity_budgets',
  'snapshot_reconciliation_identity_maps',
  'snapshot_reconciliation_identity_retirement_budgets',
  'snapshot_reconciliation_identity_retirements',
  'snapshot_reconciliation_membership_budgets',
  'snapshot_reconciliation_memberships',
  'snapshot_reconciliation_membership_retirements',
  'snapshot_reconciliation_provenance_budgets',
  'snapshot_reconciliation_provenance',
  'snapshot_reconciliation_window_progress',
  'internalize_receipts'
] as const
const cells: Readonly<
  Record<
    string,
    readonly Readonly<{ family: 'binary' | 'text'; id: number; first: number; fields: readonly string[] }>[]
  >
> = {
  transactions: [
    { family: 'binary', id: 0, first: 0, fields: ['rawTx', 'inputBEEF', 'noSendExpiryReclaimRawTx'] },
    {
      family: 'text',
      id: 0,
      first: 3,
      fields: ['description', 'noSendExpiryReclaimDerivationPrefix', 'noSendExpiryReclaimDerivationSuffix']
    }
  ],
  proven_txs: [{ family: 'binary', id: 1, first: 0, fields: ['rawTx', 'merklePath'] }],
  proven_tx_reqs: [
    { family: 'binary', id: 2, first: 0, fields: ['rawTx', 'inputBEEF'] },
    { family: 'text', id: 2, first: 2, fields: ['history', 'notify'] }
  ],
  outputs: [
    { family: 'binary', id: 3, first: 0, fields: ['lockingScript'] },
    {
      family: 'text',
      id: 3,
      first: 1,
      fields: [
        'outputDescription',
        'spendingDescription',
        'customInstructions',
        'derivationPrefix',
        'derivationSuffix',
        'type',
        'purpose'
      ]
    }
  ],
  commissions: [
    { family: 'binary', id: 4, first: 0, fields: ['lockingScript'] },
    { family: 'text', id: 4, first: 1, fields: ['keyOffset'] }
  ],
  sync_states: [{ family: 'text', id: 5, first: 0, fields: ['syncMap', 'errorLocal', 'errorOther'] }],
  certificates: [
    { family: 'text', id: 6, first: 0, fields: ['subject', 'revocationOutpoint', 'signature', 'verifier'] }
  ],
  certificate_fields: [{ family: 'text', id: 7, first: 0, fields: ['fieldValue', 'masterKey'] }],
  prepared_beefs: [{ family: 'binary', id: 8, first: 0, fields: ['beef'] }],
  action_batch_blobs: [{ family: 'binary', id: 9, first: 0, fields: ['bytes'] }],
  sync_transfer_parts: [{ family: 'binary', id: 10, first: 0, fields: ['bytes'] }],
  action_batches: [{ family: 'text', id: 11, first: 0, fields: ['uploadDigests', 'result', 'manifest'] }],
  sync_transfers: [{ family: 'text', id: 12, first: 0, fields: ['result'] }],
  monitor_events: [{ family: 'text', id: 13, first: 0, fields: ['details'] }],
  snapshot_reconciliation_stage_pages: [{ family: 'binary', id: 14, first: 0, fields: ['payload'] }],
  snapshot_reconciliation_provenance: [{ family: 'binary', id: 15, first: 0, fields: ['payload'] }]
}
export type IndependentNativeInventory = Readonly<
  Record<Brc38NativeLocalBaselineTable, readonly IndependentLocalCandidateRow[]>
>
export interface IndependentNativePriorRow {
  readonly rowId: number
  readonly metadata: Readonly<Record<string, unknown>>
  readonly field: Uint8Array | undefined
}
export type IndependentNativePriorInventory = Readonly<
  Record<Brc38NativePriorImportTable, readonly IndependentNativePriorRow[] | null>
>

function requireFixture(value: unknown): asserts value {
  if (!value) throw new Error('Independent finite native SQL fixture differs')
}
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
async function columns(k: Knex.Transaction, table: string): Promise<string[]> {
  const values = (await k.raw('SELECT name FROM pragma_table_info(?) ORDER BY cid LIMIT 129', [table])) as Array<{
    name: string
  }>
  requireFixture(
    values.length > 0 && values.length <= 128 && values.every(row => /^[A-Za-z][A-Za-z0-9_]*$/.test(row.name))
  )
  return values.map(row => row.name)
}
async function keys(k: Knex.Transaction, table: string): Promise<number[]> {
  const values = (await k(table)
    .select(k.raw('CAST(rowid AS TEXT) AS physical'))
    .orderBy('rowid')
    .limit(129)) as Array<{ physical: string }>
  requireFixture(values.length <= 128)
  return values.map(row => {
    requireFixture(/^-?(?:0|[1-9]\d{0,15})$/.test(row.physical))
    const value = Number(row.physical)
    requireFixture(Number.isSafeInteger(value))
    return value
  })
}
async function metadata(
  k: Knex.Transaction,
  table: string,
  rowId: number,
  names: readonly string[]
): Promise<Record<string, unknown>> {
  requireFixture(names.length > 0)
  const sizes = (await k(table)
    .whereRaw('rowid=CAST(? AS INTEGER)', [BigInt(rowId).toString()])
    .select(k.raw(names.map(() => 'coalesce(length(CAST(?? AS BLOB)),0)').join('+') + ' AS bytes', [...names]))
    .limit(2)) as Array<{ bytes: number }>
  requireFixture(
    sizes.length === 1 && Number.isSafeInteger(sizes[0].bytes) && sizes[0].bytes >= 0 && sizes[0].bytes <= 65536
  )
  const values = await k(table)
    .whereRaw('rowid=CAST(? AS INTEGER)', [BigInt(rowId).toString()])
    .select([...names])
    .options({ safeIntegers: true })
    .limit(2)
  requireFixture(values.length === 1)
  return values[0] as Record<string, unknown>
}
async function physicalCell(
  k: Knex.Transaction,
  table: string,
  rowId: number,
  field: string
): Promise<Uint8Array | null> {
  const sizes = (await k(table)
    .whereRaw('rowid=CAST(? AS INTEGER)', [BigInt(rowId).toString()])
    .select(k.raw('typeof(??) AS kind,length(CAST(?? AS BLOB)) AS bytes', [field, field]))
    .limit(2)) as Array<{ kind: string; bytes: number | null }>
  requireFixture(sizes.length === 1)
  if (sizes[0].kind === 'null') {
    requireFixture(sizes[0].bytes === null)
    return null
  }
  requireFixture(
    ['blob', 'text'].includes(sizes[0].kind) &&
      Number.isSafeInteger(sizes[0].bytes) &&
      sizes[0].bytes! >= 0 &&
      sizes[0].bytes! <= 131072
  )
  const values = (await k(table)
    .whereRaw('rowid=CAST(? AS INTEGER)', [BigInt(rowId).toString()])
    .select(field)
    .limit(2)) as Array<Record<string, unknown>>
  requireFixture(values.length === 1)
  const value = values[0][field]
  requireFixture(sizes[0].kind === 'text' ? typeof value === 'string' : value instanceof Uint8Array)
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value as Uint8Array)
  requireFixture(bytes.length === sizes[0].bytes)
  return bytes
}
async function logicalCell(
  k: Knex.Transaction,
  table: string,
  rowId: number,
  field: string,
  coordinate: Readonly<{ family: 'binary' | 'text'; id: number; first: number }>,
  ordinal: number
): Promise<Uint8Array | null> {
  const marker = await physicalCell(k, table, rowId, field),
    pointers = (await k(`brc38_native_${coordinate.family}_fields`)
      .where({ tableId: coordinate.id, fieldId: coordinate.first + ordinal, rowId: BigInt(rowId) })
      .select('sha256')
      .limit(2)) as Array<{ sha256: string }>
  requireFixture(pointers.length <= 1)
  if (pointers.length === 0) return marker
  requireFixture(marker !== null && marker.length === 0 && /^[0-9a-f]{64}$/.test(pointers[0].sha256))
  const sha256 = pointers[0].sha256,
    version = (await k(`brc38_native_${coordinate.family}_versions`)
      .where({ sha256 })
      .select('bytes', 'accepted', 'chunks', 'state')
      .limit(2)) as Array<{ bytes: number; accepted: number; chunks: number; state: string }>
  requireFixture(
    version.length === 1 &&
      version[0].state === 'SEALED' &&
      Number.isSafeInteger(version[0].bytes) &&
      version[0].bytes >= 0 &&
      version[0].bytes <= 131072 &&
      version[0].accepted === version[0].bytes &&
      Number.isSafeInteger(version[0].chunks) &&
      version[0].chunks >= 0 &&
      version[0].chunks <= 129
  )
  const sizes = (await k(`brc38_native_${coordinate.family}_chunks`)
    .where({ sha256 })
    .select('offset', 'bytes', 'chunkSha256', k.raw('length(payload) AS actualBytes'))
    .orderBy('offset')
    .limit(130)) as Array<{ offset: number; bytes: number; actualBytes: number; chunkSha256: string }>
  requireFixture(sizes.length === version[0].chunks)
  let offset = 0
  for (const chunk of sizes) {
    requireFixture(
      chunk.offset === offset &&
        Number.isSafeInteger(chunk.bytes) &&
        chunk.bytes > 0 &&
        chunk.bytes <= 65536 &&
        chunk.bytes === chunk.actualBytes &&
        chunk.bytes <= version[0].bytes - offset
    )
    offset += chunk.bytes
  }
  requireFixture(offset === version[0].bytes)
  const output = Buffer.alloc(offset)
  try {
    for (const chunk of sizes) {
      const values = (await k(`brc38_native_${coordinate.family}_chunks`)
        .where({ sha256, offset: chunk.offset })
        .select('payload')
        .limit(2)) as Array<{ payload: Uint8Array }>
      requireFixture(
        values.length === 1 &&
          values[0].payload instanceof Uint8Array &&
          values[0].payload.length === chunk.bytes &&
          hash(values[0].payload) === chunk.chunkSha256
      )
      try {
        output.set(values[0].payload, chunk.offset)
      } finally {
        values[0].payload.fill(0)
      }
    }
    requireFixture(hash(output) === sha256)
    return output
  } catch (cause) {
    output.fill(0)
    throw cause
  }
}

/** Separate bounded SQL preimage/oracle. It reads complete typed metadata and
 * exact logical bytes without any production source/candidate/inventory calls.
 * Capture before the operation, declare later postimages before mutation, and
 * compare to separately read candidates. This is synthetic oracle DATA only. */
export async function readIndependentNativeInventory(k: Knex.Transaction): Promise<IndependentNativeInventory> {
  requireFixture(k.isTransaction && !k.isCompleted() && tables.length === 48)
  const result = {} as Record<Brc38NativeLocalBaselineTable, IndependentLocalCandidateRow[]>
  let rows = 0,
    bytes = 0
  try {
    for (const table of tables) {
      const groups = cells[table] ?? [],
        payloadNames = groups.flatMap(group => [...group.fields]),
        names = (await columns(k, table)).filter(name => !payloadNames.includes(name))
      result[table] = []
      for (const rowId of await keys(k, table)) {
        requireFixture(++rows <= 128)
        const fields: Record<string, Uint8Array | null> = {},
          rowMetadata: Record<string, unknown> = {}
        result[table].push({ rowId, metadata: rowMetadata, fields })
        for (const group of groups)
          for (const [ordinal, field] of group.fields.entries()) {
            fields[field] = await logicalCell(k, table, rowId, field, group, ordinal)
            bytes += fields[field]?.length ?? 0
            requireFixture(bytes <= 1048576)
          }
        Object.assign(rowMetadata, await metadata(k, table, rowId, names))
      }
    }
    return result
  } catch (cause) {
    wipeIndependentNativeInventory(result)
    throw cause
  }
}

const prior = [
  'brc38_import_journal',
  'brc38_import_ids',
  'brc38_import_original_budget',
  'brc38_import_original',
  'brc38_import_streamed_original_budget',
  'brc38_import_streamed_original',
  'brc38_import_structured_original_budget',
  'brc38_import_structured_original',
  'private_binary_fields',
  'private_binary_chunks',
  'private_text_fields',
  'private_text_chunks',
  'private_structured_fields',
  'private_structured_chunks',
  'private_canonical_structured_fields',
  'private_canonical_structured_chunks',
  'private_projected_structured_fields',
  'private_projected_structured_chunks'
] as const
export async function readIndependentNativePriorInventory(
  k: Knex.Transaction
): Promise<IndependentNativePriorInventory> {
  const result = {} as Record<Brc38NativePriorImportTable, IndependentNativePriorRow[] | null>
  let rows = 0,
    bytes = 0
  try {
    for (const table of prior) {
      if (!(await k.schema.hasTable(table))) {
        result[table] = null
        continue
      }
      const field = table.endsWith('_chunks')
          ? 'payload'
          : ['brc38_import_original', 'brc38_import_streamed_original', 'brc38_import_structured_original'].includes(
                table
              )
            ? 'originalJson'
            : undefined,
        names = (await columns(k, table)).filter(name => name !== field)
      const retained: IndependentNativePriorRow[] = []
      result[table] = retained
      for (const rowId of await keys(k, table)) {
        requireFixture(++rows <= 128)
        const payload = field === undefined ? undefined : await physicalCell(k, table, rowId, field)
        requireFixture(payload !== null)
        bytes += payload?.length ?? 0
        requireFixture(bytes <= 1048576)
        const rowMetadata: Record<string, unknown> = {}
        retained.push({ rowId, metadata: rowMetadata, field: payload })
        Object.assign(rowMetadata, await metadata(k, table, rowId, names))
      }
    }
    return result
  } catch (cause) {
    for (const values of Object.values(result))
      for (const row of values ?? []) {
        row.field?.fill(0)
        for (const value of Object.values(row.metadata)) if (value instanceof Uint8Array) value.fill(0)
      }
    throw cause
  }
}

export function wipeIndependentNativeInventory(inventory: IndependentNativeInventory): void {
  for (const rows of Object.values(inventory))
    for (const row of rows) {
      for (const value of Object.values(row.fields)) value?.fill(0)
      for (const value of Object.values(row.metadata)) if (value instanceof Uint8Array) value.fill(0)
    }
}

/** Clone the separately read preimage BEFORE declaring a mutation. This is
 * fixture DATA; it calls no candidate/image/inventory production operation. */
export function copyIndependentNativeInventory(
  inventory: IndependentNativeInventory
): Record<Brc38NativeLocalBaselineTable, IndependentLocalCandidateRow[]> {
  return Object.fromEntries(
    tables.map(table => [
      table,
      inventory[table].map(row => ({
        rowId: row.rowId,
        metadata: Object.fromEntries(
          Object.entries(row.metadata).map(([key, value]) => [
            key,
            value instanceof Uint8Array ? Uint8Array.from(value) : value
          ])
        ),
        fields: Object.fromEntries(
          Object.entries(row.fields).map(([key, value]) => [key, value === null ? null : Uint8Array.from(value)])
        )
      }))
    ])
  ) as Record<Brc38NativeLocalBaselineTable, IndependentLocalCandidateRow[]>
}
