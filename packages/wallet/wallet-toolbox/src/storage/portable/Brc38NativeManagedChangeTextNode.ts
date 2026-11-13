import type { Knex } from 'knex'
import { managedChangeOutputFields } from '../methods/managedChange'
import { isOwnedNativeSqlite } from '../schema/ownedNativeSqliteRuntimeNode'
import { hasBrc38NativePackedTextSchema } from './Brc38NativePackedTextSchemaNode'
import { applyBrc38NativePackedTextWhere } from './Brc38NativePackedTextWalletNode'
import { brc38NativePackedTextLength } from './Brc38NativePackedTextFieldsNode'

/** Preserve original BRC29 automatic-allocation predicates on the actual
 * current query view. Physical TEXT markers cannot stand in for type/purpose
 * equality or nonempty derivations. No schema/selection verdict escapes. */
export async function applyBrc38NativeManagedChangeText(k: Knex, query: Knex.QueryBuilder, alias = 'o'): Promise<void> {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(alias)) throw new TypeError('Invalid managed change SQL alias')
  if (isOwnedNativeSqlite(k) && (await hasBrc38NativePackedTextSchema(k as Knex.Transaction))) {
    applyBrc38NativePackedTextWhere(query, 'outputs', 'type', managedChangeOutputFields.type, alias)
    applyBrc38NativePackedTextWhere(query, 'outputs', 'purpose', managedChangeOutputFields.purpose, alias)
    for (const field of ['derivationPrefix', 'derivationSuffix'] as const)
      query.whereRaw('(?)>0', [brc38NativePackedTextLength(k as Knex.Transaction, { table: 'outputs', field }, alias)])
  } else {
    query.where({
      [alias + '.type']: managedChangeOutputFields.type,
      [alias + '.purpose']: managedChangeOutputFields.purpose
    })
    for (const field of ['derivationPrefix', 'derivationSuffix'])
      query.whereNotNull(alias + '.' + field).whereNot(alias + '.' + field, '')
  }
}
