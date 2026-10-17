import type { Knex } from 'knex'
import { isOwnedNativeSqlite } from '../../schema/ownedNativeSqliteRuntimeNode'
import { hasBrc38NativeLocalPackedLayout } from '../../portable/Brc38NativeLocalPackedLayoutNode'
import {
  hasBrc38NativePackedSchema,
  brc38NativePackedBinaryLayoutDefinitions
} from '../../portable/Brc38NativePackedSchemaNode'
import {
  hasBrc38NativeLocalBaselineGenerationSchema,
  brc38NativeLocalBaselineSourceDefinitions
} from '../../portable/Brc38NativeLocalBaselineGenerationNode'

/** Exact authored optional objects only. Their entire native families are
 * inspected in the SAME real view first; an arbitrary namespace/persisted flag
 * never excludes a trigger from destination verification. */
export async function snapshotJournalNativeDestinationExtras(
  k: Knex,
  tables: readonly string[]
): Promise<readonly string[]> {
  if (!isOwnedNativeSqlite(k)) return Object.freeze([])
  if (!k.isTransaction) throw new Error('Native journal schema requires its actual retained view')
  const trx = k as Knex.Transaction,
    selected = new Set(tables),
    result: string[] = [],
    belongs = (sql: string): boolean => selected.has(/\b ON (\w+)\b/.exec(sql)?.[1] ?? '')
  if (await hasBrc38NativeLocalPackedLayout(trx)) {
    if (!(await hasBrc38NativePackedSchema(trx))) throw new Error('Native journal packed family is incomplete')
    const family = await brc38NativePackedBinaryLayoutDefinitions(trx)
    result.push(
      ...[...family.values()]
        .filter(value => value.type === 'trigger')
        .map(value => value.sql)
        .filter(sql => belongs(sql) || sql.startsWith('CREATE TRIGGER brc38_native_binary_journal_quota_'))
    )
  }
  if (await hasBrc38NativeLocalBaselineGenerationSchema(trx))
    result.push(...(await brc38NativeLocalBaselineSourceDefinitions(trx)).filter(belongs))
  return Object.freeze(result)
}
/** SQL migration rollback cannot erase a managed physical profile or leave its
 * original inventory charge/capture observers dangling. Reject BEFORE deletion;
 * the actual root/profile retirement protocol owns that separate operation. */
export async function assertSnapshotJournalOrdinaryDataDeletion(k: Knex): Promise<void> {
  if (!isOwnedNativeSqlite(k)) return
  const check = async (trx: Knex.Transaction): Promise<void> => {
    if ((await hasBrc38NativeLocalPackedLayout(trx)) || (await hasBrc38NativeLocalBaselineGenerationSchema(trx)))
      throw new Error('Managed local recovery profile requires actual inventory-owned physical retirement')
  }
  if (k.isTransaction) await check(k as Knex.Transaction)
  else await k.transaction(check)
}
