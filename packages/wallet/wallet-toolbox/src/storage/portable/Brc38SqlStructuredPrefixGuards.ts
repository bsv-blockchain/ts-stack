import type { Knex } from 'knex'

export type Brc38StructuredPrefixFamily = 'binary' | 'structured' | 'canonical' | 'text'
interface Definition {
  readonly name: string
  readonly table: string
  readonly sql: string
}
/** Current native DDL generation DATA for one drained read/write operation.
 * Exact definitions still require independent checking in each transaction. */
export async function readBrc38SqlPrefixSchemaVersion(k: Knex): Promise<number> {
  const rows = (await k.raw('PRAGMA schema_version')) as Array<{ schema_version: number }>
  if (
    rows.length !== 1 ||
    !Number.isSafeInteger(rows[0].schema_version) ||
    rows[0].schema_version < 0 ||
    rows[0].schema_version > 2147483647
  )
    throw new Error('Private immutable prefix schema generation differs')
  return rows[0].schema_version
}
/** Expected SQL DATA. These guards protect provisional prefixes before whole
 * envelope authentication installs the separate source seal. No returned SQL,
 * count or descriptor supplies a source, actor or completion admission. */
export function brc38SqlStructuredPrefixDefinitions(family: Brc38StructuredPrefixFamily): readonly Definition[] {
  const fields =
    family === 'binary'
      ? 'private_binary_fields'
      : family === 'structured'
        ? 'private_structured_fields'
        : family === 'canonical'
          ? 'private_canonical_structured_fields'
          : family === 'text'
            ? 'private_text_fields'
            : undefined
  if (fields === undefined) throw new Error('Invalid private structured prefix family')
  const chunks = fields.replace(/fields$/, 'chunks'),
    result: Definition[] = []
  const add = (table: string, operation: string, body: string): void => {
    const name = `${table}_prefix_${operation.toLowerCase()}`
    result.push({ name, table, sql: `CREATE TRIGGER ${name} BEFORE ${operation} ON ${table} BEGIN ${body} END` })
  }
  const identity = [
    'tableName',
    'position',
    'field',
    'encoding',
    'maximumBytes',
    ...(family === 'canonical' ? ['sourceBytes', 'sourceSha256'] : [])
  ]
    .map(name => `NEW.${name} IS NOT OLD.${name}`)
    .join(' OR ')
  add(
    fields,
    'INSERT',
    `SELECT CASE WHEN NEW.state!='writing' OR NEW.bytes!=0 OR NEW.chunks!=0 OR NEW.sha256 IS NOT NULL OR EXISTS(SELECT 1 FROM ${fields} WHERE tableName=NEW.tableName AND position=NEW.position AND field=NEW.field) THEN RAISE(ABORT,'Private structured prefix identity differs') END;`
  )
  add(
    fields,
    'UPDATE',
    `SELECT CASE WHEN ${identity} OR NOT ((OLD.state='writing' AND NEW.state='writing' AND NEW.sha256 IS NULL AND NEW.chunks=OLD.chunks+1 AND EXISTS(SELECT 1 FROM ${chunks} WHERE tableName=OLD.tableName AND position=OLD.position AND field=OLD.field AND offset=OLD.bytes AND NEW.bytes=OLD.bytes+bytes)) OR (OLD.state='writing' AND NEW.state='complete' AND NEW.bytes=OLD.bytes AND NEW.chunks=OLD.chunks)) THEN RAISE(ABORT,'Private structured prefix or completion differs') END;`
  )
  add(fields, 'DELETE', "SELECT RAISE(ABORT,'Private structured fields require owned source retirement');")
  add(
    chunks,
    'INSERT',
    `SELECT CASE WHEN EXISTS(SELECT 1 FROM ${chunks} WHERE tableName=NEW.tableName AND position=NEW.position AND field=NEW.field AND offset=NEW.offset) OR NOT EXISTS(SELECT 1 FROM ${fields} WHERE tableName=NEW.tableName AND position=NEW.position AND field=NEW.field AND state='writing' AND bytes=NEW.offset AND NEW.bytes<=maximumBytes-bytes) THEN RAISE(ABORT,'Private structured chunk prefix differs') END;`
  )
  add(chunks, 'UPDATE', "SELECT RAISE(ABORT,'Private structured chunk postimages are immutable');")
  add(chunks, 'DELETE', "SELECT RAISE(ABORT,'Private structured chunks require owned source retirement');")
  return result
}
export async function installBrc38SqlStructuredPrefixGuards(
  trx: Knex.Transaction,
  family: Brc38StructuredPrefixFamily
): Promise<void> {
  if (trx.isTransaction !== true) throw new Error('Private structured prefix installation requires its writer')
  for (const value of brc38SqlStructuredPrefixDefinitions(family)) await trx.raw(value.sql)
  await verifyBrc38SqlStructuredPrefixGuards(trx, family)
}
/** Fresh exact definitions in this actual view, including empty families. Old
 * unpublished staging layouts are refused; this is not a released migration. */
export async function verifyBrc38SqlStructuredPrefixGuards(k: Knex, family: Brc38StructuredPrefixFamily): Promise<6> {
  // The six distinct catalog names allow one fresh bounded scalar query;
  // every match still compares its complete definition in this actual view.
  const expected = brc38SqlStructuredPrefixDefinitions(family),
    actual = (await k('sqlite_schema')
      .whereRaw(
        '(name,type,tbl_name,CAST(sql AS BLOB)) IN (' + expected.map(() => '(?,?,?,CAST(? AS BLOB))').join(',') + ')',
        expected.flatMap(value => [value.name, 'trigger', value.table, value.sql])
      )
      .count({ count: '*' })
      .first()) as { count: unknown } | undefined
  if (actual?.count !== expected.length) throw new Error('Private structured immutable prefix definitions differ')
  return 6
}
