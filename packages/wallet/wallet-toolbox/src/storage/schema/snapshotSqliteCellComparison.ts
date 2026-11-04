import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import { isOwnedNativeSqlite } from './ownedNativeSqliteRuntimeNode'

const q = (name: string): string => '"' + name.replaceAll('"', '""') + '"'
/** Derived predicate DATA only. The v1 native contract retains SQLite's
 * original 1000 argument limit. Larger definitions retain the original SQL. */
export function snapshotSqliteCellsChanged(columns: readonly string[], native = false): string {
  const fields = [...new Set(columns)]
  if (native && fields.length > 0 && fields.length <= 500)
    return `brc38_cells_changed(${fields.flatMap(name => [`OLD.${q(name)}`, `NEW.${q(name)}`]).join(',')})`
  return fields.map(name => `CAST(OLD.${q(name)} AS BLOB) IS NOT CAST(NEW.${q(name)} AS BLOB)`).join(' OR ')
}
/** A fresh observation on the currently owned receiver. Function metadata
 * supplies no source, generation, primary, lifetime or admission verdict. */
export async function hasSnapshotSqliteCellComparison(k: Knex): Promise<boolean> {
  if (!isOwnedNativeSqlite(k)) return false
  if (!k.isTransaction) return k.transaction(trx => hasSnapshotSqliteCellComparison(trx))
  const functions: Array<{ name: string; builtin: number; type: string; enc: string; narg: number; flags: number }> =
    await k('pragma_function_list')
      .whereIn('name', ['brc38_cells_changed', 'brc38_cell_change_protocol'])
      .select('name', 'builtin', 'type', 'enc', 'narg', 'flags')
      .limit(3)
  if (functions.length === 0) return false
  if (
    functions.length !== 2 ||
    functions.some(row => row.builtin !== 0 || row.type !== 's' || row.enc !== 'utf8' || row.flags !== 2099200) ||
    functions.filter(row => row.name === 'brc38_cells_changed' && row.narg === -1).length !== 1 ||
    functions.filter(row => row.name === 'brc38_cell_change_protocol' && row.narg === 0).length !== 1
  )
    throw new WERR_INVALID_OPERATION('Native cell comparison function inventory mismatch')
  const rows: Array<{ protocol: unknown }> = await k.raw('SELECT brc38_cell_change_protocol() AS protocol')
  if (rows.length !== 1 || rows[0].protocol !== 'brc38-cell-change/v1')
    throw new WERR_INVALID_OPERATION('Native cell comparison protocol mismatch')
  return true
}
