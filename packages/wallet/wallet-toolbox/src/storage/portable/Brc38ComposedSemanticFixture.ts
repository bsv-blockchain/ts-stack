import { expect } from '@jest/globals'
import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import { StorageKnex } from '../StorageKnex'
import type { WalletStorageManager } from '../WalletStorageManager'
import type { BRC38WalletData } from './index'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'

type Row = Record<string, unknown>
export type ComposedSemanticFixture = Readonly<Record<string, readonly Readonly<Row>[]>>
// Independent physical names, logical keys, packed coordinates and journal
// coordinates. No production table/field whitelist, inventory, image or merge
// policy supplies this small-fixture oracle's expected postimages.
const tables = [
  ['provenTxs', 'proven_txs'],
  ['outputBaskets', 'output_baskets'],
  ['outputTags', 'output_tags'],
  ['txLabels', 'tx_labels'],
  ['transactions', 'transactions'],
  ['outputs', 'outputs'],
  ['txLabelMaps', 'tx_labels_map'],
  ['outputTagMaps', 'output_tags_map'],
  ['certificates', 'certificates'],
  ['certificateFields', 'certificate_fields'],
  ['commissions', 'commissions'],
  ['provenTxReqs', 'proven_tx_reqs'],
  ['syncStates', 'sync_states']
] as const
const packed = [
  {
    table: 'transactions',
    key: 'transactionId',
    id: 0,
    binary: ['rawTx', 'inputBEEF', 'noSendExpiryReclaimRawTx'],
    textAt: 3,
    text: ['description', 'noSendExpiryReclaimDerivationPrefix', 'noSendExpiryReclaimDerivationSuffix']
  },
  { table: 'proven_txs', key: 'provenTxId', id: 1, binary: ['rawTx', 'merklePath'], textAt: 0, text: [] },
  {
    table: 'proven_tx_reqs',
    key: 'provenTxReqId',
    id: 2,
    binary: ['rawTx', 'inputBEEF'],
    textAt: 2,
    text: ['history', 'notify']
  },
  {
    table: 'outputs',
    key: 'outputId',
    id: 3,
    binary: ['lockingScript'],
    textAt: 1,
    text: [
      'outputDescription',
      'spendingDescription',
      'customInstructions',
      'derivationPrefix',
      'derivationSuffix',
      'type',
      'purpose'
    ]
  },
  { table: 'commissions', key: 'commissionId', id: 4, binary: ['lockingScript'], textAt: 1, text: ['keyOffset'] },
  {
    table: 'sync_states',
    key: 'syncStateId',
    id: 5,
    binary: [],
    textAt: 0,
    text: ['syncMap', 'errorLocal', 'errorOther']
  },
  {
    table: 'certificates',
    key: 'certificateId',
    id: 6,
    binary: [],
    textAt: 0,
    text: ['subject', 'revocationOutpoint', 'signature', 'verifier']
  },
  {
    table: 'certificate_fields',
    key: '__fixtureRowId',
    id: 7,
    binary: [],
    textAt: 0,
    text: ['fieldValue', 'masterKey']
  }
] as const
const journalKeys = [
  ['transactions', 'transactionId'],
  ['outputs', 'outputId'],
  ['certificates', 'certificateId'],
  ['tx_labels', 'txLabelId'],
  ['output_baskets', 'basketId'],
  ['output_tags', 'outputTagId'],
  ['commissions', 'commissionId'],
  ['sync_states', 'syncStateId'],
  ['proven_txs', 'provenTxId'],
  ['proven_tx_reqs', 'provenTxReqId'],
  ['tx_labels_map', 'txLabelId'],
  ['output_tags_map', 'outputTagId'],
  ['certificate_fields', 'certificateId']
] as const
const hash = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex')
const maximumCellBytes = 1048576

/** Whole values are deliberately allowed only for this bounded synthetic
 * fixture. This is an independent semantic oracle, not a production reader or
 * proof of streaming allocation, query cost or native RSS. All cases UNRUN. */
export async function withComposedFixtureRead<T>(
  manager: WalletStorageManager,
  work: (read: Knex.Transaction) => Promise<T>
): Promise<T> {
  return await manager.runAsStorageProvider(async storage => {
    if (!(storage instanceof StorageKnex)) throw new Error('Semantic fixture requires its actual native manager')
    const driver = require('./NativeProfileSqlite.cjs') as { createOwnedNativeReadDatabase(root: Knex): Knex },
      reader = driver.createOwnedNativeReadDatabase(storage.knex)
    let result: T,
      failure: unknown,
      failed = false
    try {
      result = await reader.transaction(work)
    } catch (cause) {
      failed = true
      failure = cause
    }
    try {
      await reader.destroy()
    } catch (error_) {
      throw new Brc38StagingCleanupError(
        [...(failed ? [failure] : []), error_],
        'Independent semantic fixture retains its real read pool',
        async () => await reader.destroy()
      )
    }
    if (failed) throw failure
    return result!
  })
}

async function content(read: Knex.Transaction, family: 'binary' | 'text', sha256: string): Promise<Buffer> {
  const version = await read(`brc38_native_${family}_versions`).where({ sha256 }).first(),
    chunks = await read(`brc38_native_${family}_chunks`).where({ sha256 }).orderBy('offset').limit(1025)
  expect(version).toBeDefined()
  expect(version.state).toBe('SEALED')
  expect(Number.isSafeInteger(version.bytes)).toBe(true)
  expect(version.bytes).toBeLessThanOrEqual(maximumCellBytes)
  expect(version.accepted).toBe(version.bytes)
  expect(chunks.length).toBe(version.chunks)
  let offset = 0
  const parts: Buffer[] = []
  for (const chunk of chunks) {
    const bytes = Buffer.from(chunk.payload)
    expect(bytes.length).toBeLessThanOrEqual(65536)
    expect(bytes.length).toBeGreaterThan(0)
    expect(chunk.offset).toBe(offset)
    expect(chunk.bytes).toBe(bytes.length)
    expect(hash(bytes)).toBe(chunk.chunkSha256)
    offset += bytes.length
    parts.push(bytes)
  }
  const result = Buffer.concat(parts)
  expect(result.length).toBe(version.bytes)
  expect(hash(result)).toBe(sha256)
  return result
}

async function walletRows(read: Knex.Transaction): Promise<Record<string, Row[]>> {
  const result: Record<string, Row[]> = {}
  let totalBytes = 0
  for (const table of ['users', ...tables.map(([, physical]) => physical)]) {
    const columns = (await read.raw('SELECT name FROM pragma_table_info(?) ORDER BY cid LIMIT 65', [table])) as Array<{
      name: string
    }>
    expect(columns.length).toBeGreaterThan(0)
    expect(columns.length).toBeLessThanOrEqual(64)
    const sizes = (await read(table)
      .select(
        read.raw(
          columns.map(() => 'coalesce(length(CAST(?? AS BLOB)),0)').join('+') + ' AS bytes',
          columns.map(column => column.name)
        )
      )
      .limit(3)) as Array<{ bytes: number }>
    // One row in each original fixture table, plus any separately declared
    // physical tombstone. Extra wallet/profile records fail before transfer.
    expect(sizes).toHaveLength(1)
    expect(sizes[0].bytes).toBeLessThanOrEqual(maximumCellBytes)
    const rows = (await read(table).select('*', read.raw('rowid AS __fixtureRowId')).orderBy('rowid').limit(3)) as Row[]
    const coordinates = packed.find(value => value.table === table)
    for (const row of rows) {
      if (coordinates !== undefined)
        for (const family of ['binary', 'text'] as const) {
          const fields: readonly string[] = family === 'binary' ? coordinates.binary : coordinates.text
          for (const [index, field] of fields.entries()) {
            const pointers = await read(`brc38_native_${family}_fields`)
              .where({
                tableId: coordinates.id,
                rowId: row[coordinates.key],
                fieldId: index + (family === 'text' ? coordinates.textAt : 0)
              })
              .select('sha256')
              .limit(2)
            expect(pointers.length).toBeLessThanOrEqual(1)
            if (row[field] === null) {
              expect(pointers).toHaveLength(0)
              continue
            }
            if (pointers.length !== 0) {
              expect(
                family === 'binary'
                  ? Buffer.from(row[field] as Uint8Array).length
                  : Buffer.byteLength(row[field] as string)
              ).toBe(0)
              const bytes = await content(read, family, pointers[0].sha256)
              row[field] = family === 'binary' ? bytes : new TextDecoder('utf-8', { fatal: true }).decode(bytes)
            }
          }
        }
      delete row.__fixtureRowId
      for (const [field, value] of Object.entries(row)) {
        if (
          (field === 'created_at' || field === 'updated_at' || (table === 'sync_states' && field === 'when')) &&
          value !== null
        )
          row[field] = new Date(value as string | number).toISOString()
        else if (value instanceof Uint8Array) row[field] = Buffer.from(value)
        totalBytes +=
          typeof row[field] === 'string'
            ? Buffer.byteLength(row[field] as string)
            : row[field] instanceof Uint8Array
              ? (row[field] as Uint8Array).byteLength
              : 64
        // Current structured spelling can be canonicalized by a merge. Compare
        // every logical value independently; original raw spelling is checked
        // separately against the incoming document below.
        if (
          ((table === 'proven_tx_reqs' && (field === 'history' || field === 'notify')) ||
            (table === 'sync_states' && field === 'syncMap')) &&
          typeof row[field] === 'string'
        )
          row[field] = JSON.parse(row[field] as string) as unknown
      }
      expect(totalBytes).toBeLessThanOrEqual(4194304)
    }
    result[table] = rows
  }
  return result
}

export async function captureComposedSemanticFixture(manager: WalletStorageManager): Promise<ComposedSemanticFixture> {
  return await withComposedFixtureRead(manager, walletRows)
}

/** Declare the only expected changes for this same-identity one-row archive
 * BEFORE running the import. Older records on every other table remain exact,
 * including relationships, nullable fields, legacy basket policy and tombstones. */
export function composedTransactionPostimage(
  before: ComposedSemanticFixture,
  description: string,
  updatedAt: string
): ComposedSemanticFixture {
  if (before.transactions.length !== 1) throw new Error('Semantic fixture requires one transaction')
  return { ...before, transactions: [{ ...before.transactions[0], description, updated_at: updatedAt }] }
}

/** Independent small-model checkpoint rules for this already occupied graph.
 * Incoming operational values remain inert. A completed import keeps prior
 * mappings/extras, maps each incoming natural identity to the existing local
 * identity, advances maxima and resets counts. Generated per-page timestamps
 * are superseded by the matching original final sync-state timestamp here. */
export function composedArchivePostimage(
  before: ComposedSemanticFixture,
  incoming: BRC38WalletData
): ComposedSemanticFixture {
  const sync = before.sync_states[0],
    map = structuredClone(sync.syncMap) as Record<
      string,
      { count: number; idMap: Record<string, number>; maxUpdated_at?: string }
    >,
    entities = [
      ['provenTxs', 'proven_txs', 'provenTx', 'provenTxId'],
      ['outputBaskets', 'output_baskets', 'outputBasket', 'basketId'],
      ['outputTags', 'output_tags', 'outputTag', 'outputTagId'],
      ['txLabels', 'tx_labels', 'txLabel', 'txLabelId'],
      ['transactions', 'transactions', 'transaction', 'transactionId'],
      ['outputs', 'outputs', 'output', 'outputId'],
      ['txLabelMaps', 'tx_labels_map', 'txLabelMap', undefined],
      ['outputTagMaps', 'output_tags_map', 'outputTagMap', undefined],
      ['certificates', 'certificates', 'certificate', 'certificateId'],
      ['certificateFields', 'certificate_fields', 'certificateField', undefined],
      ['commissions', 'commissions', 'commission', 'commissionId'],
      ['provenTxReqs', 'proven_tx_reqs', 'provenTxReq', 'provenTxReqId']
    ] as const
  for (const [table, physical, entity, id] of entities) {
    const row = incoming.tables[table][0],
      entry = map[entity],
      updatedAt = new Date(row.updated_at as string).toISOString()
    if (entry === undefined || entry.idMap === undefined || before[physical].length !== 1)
      throw new Error('Independent checkpoint fixture requires its complete prior twelve-entity map')
    entry.count = 0
    if (entry.maxUpdated_at === undefined || updatedAt > entry.maxUpdated_at) entry.maxUpdated_at = updatedAt
    if (id !== undefined) entry.idMap[String(row[id])] = before[physical][0][id] as number
  }
  const matching = incoming.tables.syncStates.find(
    row =>
      row.storageIdentityKey === incoming.sourceStorage.storageIdentityKey &&
      row.storageName === incoming.sourceStorage.storageName
  )
  if (matching === undefined)
    throw new Error('Independent checkpoint fixture needs the matching original final timestamp')
  const maximum = Object.values(map)
      .map(entry => entry.maxUpdated_at)
      .filter((value): value is string => value !== undefined)
      .sort((a, b) => Number(a > b) - Number(a < b))
      .at(-1),
    checkpoint = {
      ...sync,
      storageName: incoming.sourceStorage.storageName,
      updated_at: matching.updated_at,
      when: matching.when ?? maximum ?? null,
      syncMap: map
    },
    tx = incoming.tables.transactions[0],
    current = before.transactions[0],
    result =
      Date.parse(tx.updated_at as string) > Date.parse(current.updated_at as string)
        ? composedTransactionPostimage(before, tx.description as string, tx.updated_at as string)
        : before
  return { ...result, sync_states: [checkpoint] }
}

export async function assertComposedSemanticFixture(
  manager: WalletStorageManager,
  expected: ComposedSemanticFixture
): Promise<void> {
  await withComposedFixtureRead(manager, async read => {
    const actual = await walletRows(read)
    expect(actual).toEqual(expected)
    const one = (table: string): Row => actual[table][0],
      user = one('users'),
      tx = one('transactions'),
      output = one('outputs'),
      certificate = one('certificates'),
      request = one('proven_tx_reqs'),
      proof = one('proven_txs')
    for (const rows of Object.values(actual))
      for (const row of rows) if (Object.hasOwn(row, 'userId')) expect(row.userId).toBe(user.userId)
    expect(tx.provenTxId).toBe(proof.provenTxId)
    expect(request.provenTxId).toBe(proof.provenTxId)
    expect(output.transactionId).toBe(tx.transactionId)
    expect(output.spentBy).toBe(tx.transactionId)
    expect(output.basketId).toBe(one('output_baskets').basketId)
    expect(one('commissions').transactionId).toBe(tx.transactionId)
    expect(one('certificate_fields').certificateId).toBe(certificate.certificateId)
    expect(one('tx_labels_map').transactionId).toBe(tx.transactionId)
    expect(one('tx_labels_map').txLabelId).toBe(one('tx_labels').txLabelId)
    expect(one('output_tags_map').outputId).toBe(output.outputId)
    expect(one('output_tags_map').outputTagId).toBe(one('output_tags').outputTagId)
    expect(one('output_tags').isDeleted).toBe(1)
    expect(one('output_tags_map').isDeleted).toBe(1)
    expect(certificate.isDeleted).toBe(1)
    const clock = await read('snapshot_journal_clock').where({ id: 1 }).first(),
      generation = await read('snapshot_journal_generation').where({ id: 1 }).first()
    expect(clock.enabled).toBe(1)
    expect(clock.reason).toBeNull()
    expect(generation.complete).toBe(1)
    for (const [tableId, [table, key]] of journalKeys.entries()) {
      const row = one(table),
        id2 = tableId === 10 ? row.transactionId : tableId === 11 ? row.outputId : 0,
        exactText = tableId === 12 ? row.fieldName : '',
        points = await read('snapshot_journal_physical').where({ tableId, id1: row[key], id2, exactText }).limit(2)
      expect(points).toHaveLength(1)
      expect(points[0].present).toBe(1)
      expect(BigInt(points[0].generation)).toBeLessThanOrEqual(BigInt(points[0].revision))
      expect(BigInt(points[0].revision)).toBeLessThanOrEqual(BigInt(clock.revision))
      const scopes = await read('snapshot_journal_scope')
        .where({ tableId, userId: user.userId, id1: row[key], id2, exactText })
        .limit(2)
      expect(scopes).toHaveLength(1)
      expect(scopes[0].present).toBe(1)
      expect(BigInt(scopes[0].revision)).toBeLessThanOrEqual(BigInt(clock.revision))
    }
  })
}

/** Full original incoming custody, independently compared with the pre-import
 * document. The original IDs, primary, source metadata and unmapped notify /
 * sync-state values must survive separately from operational postimages. */
export async function assertComposedIncomingOriginals(
  manager: WalletStorageManager,
  importId: string,
  incoming: BRC38WalletData
): Promise<void> {
  await withComposedFixtureRead(manager, async read => {
    const records = await read('brc38_import_structured_original').where({ importId }).orderBy('sourceRow').limit(15)
    expect(records).toHaveLength(14)
    const parse = (index: number): Row => {
        const record = records[index]
        expect(record.sourceRow).toBe(index)
        expect(Buffer.byteLength(record.originalJson)).toBeLessThanOrEqual(maximumCellBytes)
        expect(hash(record.originalJson)).toBe(record.sha256)
        expect(record.logicalBytes).toBe(512 + Buffer.byteLength(record.originalJson))
        return JSON.parse(record.originalJson) as Row
      },
      header = parse(0)
    expect(records[0].tableName).toBe('header')
    expect(header.user).toEqual(incoming.user)
    expect(header.sourceStorage).toEqual(incoming.sourceStorage)
    for (const [index, [table]] of tables.entries()) {
      const original = parse(index + 1),
        wanted = { ...incoming.tables[table][0] },
        fields = original.fields as Row
      expect(records[index + 1].tableName).toBe(table)
      expect(original.protocol).toBe('brc38-structured-original/v1')
      expect(original.table).toBe(table)
      expect(original.index).toBe(0)
      for (const [family, descriptors] of [
        ['binary', original.binaries],
        ['structured', original.structured],
        ['text', original.texts]
      ] as const) {
        for (const [field, value] of Object.entries((descriptors ?? {}) as Row)) {
          const descriptor = value as { bytes: number; sha256: string; field: string },
            coordinate = { tableName: table, position: 0, field },
            metadata = await read(`private_${family}_fields`).where(coordinate).first(),
            chunks = await read(`private_${family}_chunks`).where(coordinate).orderBy('offset').limit(1025),
            parts: Buffer[] = []
          expect(descriptor.field).toBe(field)
          expect(metadata.state).toBe('complete')
          expect(metadata.bytes).toBeLessThanOrEqual(maximumCellBytes)
          expect(chunks.length).toBe(metadata.chunks)
          let offset = 0
          for (const chunk of chunks) {
            const bytes = Buffer.from(chunk.payload)
            expect(chunk.offset).toBe(offset)
            expect(chunk.bytes).toBe(bytes.length)
            expect(bytes.length).toBeLessThanOrEqual(65536)
            expect(hash(bytes)).toBe(chunk.sha256)
            offset += bytes.length
            parts.push(bytes)
          }
          const bytes = Buffer.concat(parts),
            expectedBytes =
              family === 'binary'
                ? Array.isArray(wanted[field])
                  ? Buffer.from(wanted[field] as number[])
                  : Buffer.from(wanted[field] as string, 'base64')
                : Buffer.from(family === 'structured' ? JSON.stringify(wanted[field]) : (wanted[field] as string))
          expect(bytes).toEqual(expectedBytes)
          expect(bytes.length).toBe(metadata.bytes)
          expect(descriptor.bytes).toBe(bytes.length)
          expect(hash(bytes)).toBe(metadata.sha256)
          expect(metadata.sha256).toBe(descriptor.sha256)
          delete wanted[field]
        }
      }
      expect(fields).toEqual(wanted)
    }
  })
}
