import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import type { Brc38ImportRowTypes } from './Brc38ImportPage'
import type { Brc38NativeTextRead } from './Brc38NativeBlobProtocol'
import { insertBrc38PackedRestoreMetadata } from './Brc38PackedRestoreMetadataNode'
import {
  prepareBrc38NativePackedTextWalletWrite,
  finishBrc38NativePackedTextWalletWrite,
  hydrateBrc38NativePackedTextWalletRows,
  applyBrc38NativePackedTextWhere
} from './Brc38NativePackedTextWalletNode'
import { readBrc38NativePackedTextDescriptor } from './Brc38NativePackedTextFieldsNode'
import { writeBrc38NativePackedBytes } from './Brc38NativePackedFieldsNode'
import { createHash } from 'node:crypto'

type TextTable =
  'transactions' | 'outputs' | 'commissions' | 'certificates' | 'certificateFields' | 'provenTxReqs' | 'syncStates'
export type NativePayloadTextFixture = {
  [K in TextTable]: Readonly<{ table: K; row: Readonly<Brc38ImportRowTypes[K]> }>
}[TextTable]
// Independent coordinates: do not derive this oracle from implementation maps.
const cases = {
  transactions: [
    'transactions',
    'transactionId',
    ['description', 'noSendExpiryReclaimDerivationPrefix', 'noSendExpiryReclaimDerivationSuffix']
  ],
  outputs: [
    'outputs',
    'outputId',
    [
      'outputDescription',
      'spendingDescription',
      'customInstructions',
      'derivationPrefix',
      'derivationSuffix',
      'type',
      'purpose'
    ]
  ],
  commissions: ['commissions', 'commissionId', ['keyOffset']],
  certificates: ['certificates', 'certificateId', ['subject', 'revocationOutpoint', 'signature', 'verifier']],
  certificateFields: ['certificate_fields', 'rowid', ['fieldValue', 'masterKey']],
  provenTxReqs: ['proven_tx_reqs', 'provenTxReqId', ['history', 'notify']],
  syncStates: ['sync_states', 'syncStateId', ['syncMap', 'errorLocal', 'errorOther']]
} as const
function requireCase(condition: boolean): asserts condition {
  if (!condition) throw new Error('Independent complete native TEXT destination oracle differs')
}
/** Authored UNRUN. The finite native controller supplies seven complete rows
 * with actual parents, null optional binary cells and empty required binary
 * extents. Every text is independently seeded
 * with BOM/NUL/non-ASCII/boundary fixtures. This case selects no runtime/pool,
 * authenticates no archive and makes no complete-system qualification claim. */
export async function verifyNativePackedPayloadText(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  fixtures: readonly NativePayloadTextFixture[]
): Promise<void> {
  requireCase(
    fixtures.length === 7 &&
      new Set(fixtures.map(value => value.table)).size === 7 &&
      Object.keys(cases).every(table => fixtures.some(value => value.table === table))
  )
  const writer = async <T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T> =>
    await store.withPrivateNativeDatabase(
      false,
      async root =>
        await root.transaction(async trx => {
          store.assertPrivateNativeWriteTransaction(trx)
          return await work(trx)
        })
    )
  for (const fixture of fixtures) {
    const [sql, key, names] = cases[fixture.table],
      original: Record<string, unknown> = { ...fixture.row }
    requireCase(names.every(name => typeof original[name] === 'string' && (original[name] as string).length <= 131072))
    const requiredBinary =
      fixture.table === 'provenTxReqs' ? 'rawTx' : fixture.table === 'commissions' ? 'lockingScript' : undefined
    for (const name of ['rawTx', 'inputBEEF', 'lockingScript']) {
      const value = original[name]
      requireCase(name === requiredBinary ? Array.isArray(value) && value.length === 0 : value == null)
    }
    if (fixture.table === 'syncStates') requireCase(original.syncStateId === 0 || original.syncStateId === -1)
    const prepared = prepareBrc38NativePackedTextWalletWrite(sql, original),
      metadata = { ...prepared.row }
    if (requiredBinary !== undefined) delete metadata[requiredBinary]
    if (fixture.table !== 'certificateFields' && fixture.table !== 'syncStates') metadata[key] = 0
    const count = async (trx: Knex.Transaction): Promise<number> => {
        const row = await trx(sql).count({ count: '*' }).first()
        requireCase(typeof row?.count === 'number' && Number.isSafeInteger(row.count))
        return row.count
      },
      before = await writer(count),
      interruption = new Error('Rollback complete text row and pointer family'),
      insert = async (trx: Knex.Transaction): Promise<number> => {
        const id = await insertBrc38PackedRestoreMetadata(
          storage,
          trx,
          fixture.table,
          metadata,
          requiredBinary === undefined ? [] : [requiredBinary],
          { remaining: 16777216, maximum: 16777216 }
        )
        requireCase(typeof id === 'number' && Number.isSafeInteger(id))
        if (fixture.table === 'provenTxReqs' || fixture.table === 'commissions')
          await writeBrc38NativePackedBytes(
            trx,
            { table: fixture.table, field: fixture.table === 'provenTxReqs' ? 'rawTx' : 'lockingScript', rowId: id },
            new Uint8Array(0)
          )
        await finishBrc38NativePackedTextWalletWrite(trx, sql, id, prepared.fields)
        const physical = await trx(sql).where(key, id).first()
        requireCase(physical !== undefined && names.every(name => physical[name] === ''))
        const hydrated = await hydrateBrc38NativePackedTextWalletRows(trx, sql, [{ ...physical }])
        for (const name of names) {
          requireCase(hydrated[0][name] === original[name])
          const field = name as Brc38NativeTextRead['field'],
            expected = Buffer.from(original[name] as string, 'utf8'),
            descriptor = await readBrc38NativePackedTextDescriptor(trx, { table: fixture.table, field, rowId: id })
          try {
            requireCase(
              descriptor?.bytes === expected.byteLength &&
                descriptor.sha256 === createHash('sha256').update(expected).digest('hex')
            )
            const matching = trx(sql).where(key, id)
            applyBrc38NativePackedTextWhere(matching, sql, field, original[name] as string)
            requireCase((await matching.select(key)).length === 1)
            const different = trx(sql).where(key, id)
            applyBrc38NativePackedTextWhere(different, sql, field, (original[name] as string) + '\u0000')
            requireCase((await different.select(key)).length === 0)
          } finally {
            expected.fill(0)
          }
        }
        if (fixture.table === 'certificateFields') requireCase(!Object.hasOwn(hydrated[0], 'rowid'))
        return id
      }
    try {
      let rolledBack = false
      try {
        await writer(async trx => {
          await insert(trx)
          throw interruption
        })
      } catch (cause) {
        requireCase(cause === interruption)
        rolledBack = true
      }
      requireCase(rolledBack && (await writer(count)) === before)
      const id = await writer(insert)
      requireCase((await writer(count)) === before + 1)
      await writer(async trx => {
        const partial = { [key]: id },
          args = { partial, trx },
          rows =
            fixture.table === 'transactions'
              ? await storage.findTransactions({ ...args, noRawTx: true })
              : fixture.table === 'outputs'
                ? await storage.findOutputs({ ...args, noScript: true })
                : fixture.table === 'commissions'
                  ? await storage.findCommissions(args)
                  : fixture.table === 'certificates'
                    ? await storage.findCertificates(args)
                    : fixture.table === 'provenTxReqs'
                      ? await storage.findProvenTxReqs(args)
                      : fixture.table === 'syncStates'
                        ? await storage.findSyncStates(args)
                        : await storage.findCertificateFields({
                            partial: {
                              certificateId: original.certificateId as number,
                              fieldName: original.fieldName as string
                            },
                            trx
                          })
        requireCase(rows.length === 1)
        for (const name of names) requireCase(Object.getOwnPropertyDescriptor(rows[0], name)?.value === original[name])
        if (fixture.table === 'syncStates') {
          // This archived ID may be zero or negative. An ordinary native
          // update must include it in its bounded keyset, and retain its key.
          const errorLocal = (original.errorLocal as string) + '\u0000updated'
          requireCase((await storage.updateSyncState(id, { errorLocal }, trx)) === 1)
          const actual = await storage.findSyncStates({ partial: { syncStateId: id }, trx })
          requireCase(actual.length === 1 && actual[0].syncStateId === id && actual[0].errorLocal === errorLocal)
        }
        if (fixture.table === 'certificateFields') {
          const fieldName = (original.fieldName as string) + '-moved'
          requireCase(
            (await storage.updateCertificateField(
              original.certificateId as number,
              original.fieldName as string,
              { fieldName, fieldValue: original.fieldValue as string },
              trx
            )) === 1
          )
          const actual = await storage.findCertificateFields({
            partial: { certificateId: original.certificateId as number, fieldName },
            trx
          })
          requireCase(
            actual.length === 1 && actual[0].fieldValue === original.fieldValue && !Object.hasOwn(actual[0], 'rowid')
          )
          const physical: Array<{ rowid: number }> = await trx(sql)
            .where({ certificateId: original.certificateId, fieldName })
            .select('rowid')
          requireCase(physical.length === 1 && physical[0].rowid === id)
        }
      })
    } finally {
      for (const field of prepared.fields) field.bytes.fill(0)
    }
  }
}
