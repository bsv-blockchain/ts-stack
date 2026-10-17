import type { Knex } from 'knex'
import { createHash } from 'node:crypto'
import { brc38NativeLocalBaselineTables } from './Brc38NativeLocalBaselineTables'
import { brc38WorkingAllocation, type Brc38WorkingAllocation } from './Brc38WorkingAllocation'

export interface Brc38ComposedDatabaseImage {
  readonly protocol: 'brc38-composed-database-image/v1'
  readonly sha256: string
  readonly schemaObjects: number
  readonly tables: number
  readonly rows: string
  readonly cellBytes: string
}
export interface Brc38ComposedDatabaseImagePolicy {
  readonly maximumPhysicalBytes: number
  readonly maximumReadBytes: number
  readonly expiresAt: number
  readonly workingAllocation: Brc38WorkingAllocation
  readonly signal?: AbortSignal
}
function invalid(): never {
  throw new Error('Composed database image differs from its bounded original read')
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)) invalid()
  return value
}
function signed(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(0|-?[1-9][0-9]{0,18})$/.test(value) ||
    BigInt(value) < -9223372036854775808n ||
    BigInt(value) > 9223372036854775807n
  )
    invalid()
  return value
}

/** Full physical SQL image DATA, including every recovery, custody, field
 * pointer, chunk and sequence table, rather than only archive wallet rows.
 * The caller retains its genuine read actor, frozen source or receiving owner,
 * and physical/catalog checks. A matching image is never semantic, READY,
 * publication, native-claim or primary-selection authority. All values retain
 * their SQLite storage type; full TEXT/BLOB bytes are streamed, including NULs.
 * Explicit JS allocation is charged here; SQLite RSS remains a separate gate.
 */
export async function readBrc38ComposedDatabaseImage(
  k: Knex.Transaction,
  selected: Brc38ComposedDatabaseImagePolicy,
  assertRead: () => void
): Promise<Readonly<Brc38ComposedDatabaseImage>> {
  const policy = Object.freeze({
      maximumPhysicalBytes: selected.maximumPhysicalBytes,
      maximumReadBytes: selected.maximumReadBytes,
      expiresAt: selected.expiresAt,
      workingAllocation: brc38WorkingAllocation(selected.workingAllocation),
      signal: selected.signal
    }),
    lifetime = policy.expiresAt - Date.now(),
    began = performance.now()
  if (
    policy.workingAllocation === undefined ||
    !Number.isSafeInteger(policy.maximumPhysicalBytes) ||
    policy.maximumPhysicalBytes < 4096 ||
    !Number.isSafeInteger(policy.maximumReadBytes) ||
    policy.maximumReadBytes < 1 ||
    policy.maximumReadBytes > 16384 ||
    !Number.isSafeInteger(policy.expiresAt) ||
    lifetime < 1
  )
    invalid()
  const check = (): void => {
      policy.signal?.throwIfAborted()
      assertRead()
      if (
        !k.isTransaction ||
        k.isCompleted() ||
        Date.now() >= policy.expiresAt ||
        performance.now() - began >= lifetime
      )
        invalid()
    },
    charge = policy.workingAllocation.claim(1048576),
    hash = createHash('sha256'),
    add = (value: unknown): void => {
      hash.update(JSON.stringify(value))
      hash.update('\n')
    },
    maximumBytes = BigInt(policy.maximumPhysicalBytes) * 4n,
    required = new Set<string>(brc38NativeLocalBaselineTables)
  let schemaObjects = 0,
    tables = 0,
    rows = 0n,
    cellBytes = 0n,
    after: string | undefined,
    operations = 0
  const yieldRead = async (): Promise<void> => {
    if (++operations % 128 === 0) {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      check()
    }
  }
  try {
    check()
    add('brc38-composed-database-image/v1')
    for (;;) {
      check()
      const query = k('sqlite_schema')
        .select(
          k.raw('CAST(rowid AS TEXT) AS imageRowId'),
          ...['type', 'name', 'tbl_name'].map(field =>
            k.raw("CASE WHEN typeof(??)='text' AND length(CAST(?? AS BLOB))<=128 THEN ?? END AS ??", [
              field,
              field,
              field,
              field
            ])
          ),
          k.raw(
            "CASE WHEN sql IS NULL THEN NULL WHEN typeof(sql)='text' AND length(CAST(sql AS BLOB))<=65536 THEN sql END AS imageSql"
          ),
          k.raw('sql IS NULL AS imageSqlNull')
        )
        .orderBy('rowid')
        .limit(1)
      if (after !== undefined) query.whereRaw('rowid>CAST(? AS INTEGER)', [after])
      const objects = (await query) as Array<{
        imageRowId: unknown
        type: unknown
        name: unknown
        tbl_name: unknown
        imageSql: unknown
        imageSqlNull: unknown
      }>
      check()
      if (objects.length === 0) break
      if (objects.length !== 1 || ++schemaObjects > 4096) invalid()
      const object = objects[0],
        at = signed(object.imageRowId),
        name = identifier(object.name),
        table = identifier(object.tbl_name)
      if (
        (after !== undefined && BigInt(at) <= BigInt(after)) ||
        !['table', 'index', 'trigger', 'view'].includes(object.type as string) ||
        !(
          (object.imageSqlNull === 1 && object.imageSql === null) ||
          (object.imageSqlNull === 0 && typeof object.imageSql === 'string')
        )
      )
        invalid()
      // Schema rowids and rootpage locations are physical allocation details,
      // but their original ordering is retained across this exact file copy.
      add([object.type, name, table, object.imageSql])
      after = at
      if (object.type !== 'table') continue
      if (
        ++tables > 512 ||
        typeof object.imageSql !== 'string' ||
        /^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(object.imageSql)
      )
        invalid()
      const withoutRowid = /\)\s*WITHOUT\s+ROWID\b/i.test(object.imageSql)
      required.delete(name)
      const columns = (await k.raw(
        'SELECT cid,name,type,"notnull",dflt_value,pk,hidden FROM pragma_table_xinfo(?) ORDER BY cid LIMIT 129',
        [name]
      )) as Array<{
        cid: unknown
        name: unknown
        type: unknown
        notnull: unknown
        dflt_value: unknown
        pk: unknown
        hidden: unknown
      }>
      check()
      if (columns.length < 1 || columns.length > 128) invalid()
      for (let index = 0; index < columns.length; index++) {
        const column = columns[index],
          field = identifier(column.name)
        if (
          column.cid !== index ||
          column.hidden !== 0 ||
          typeof column.type !== 'string' ||
          Buffer.byteLength(column.type) > 128 ||
          ![0, 1].includes(column.notnull as number) ||
          !Number.isSafeInteger(column.pk) ||
          !(
            column.dflt_value === null ||
            (typeof column.dflt_value === 'string' && Buffer.byteLength(column.dflt_value) <= 65536)
          )
        )
          invalid()
        add([column.cid, field, column.type, column.notnull, column.dflt_value, column.pk])
      }
      // SQLite exposes three aliases for its physical rowid. An ordinary
      // authored rowId field shadows only one; never use it as the row key.
      const implicitRowid = ['rowid', '_rowid_', 'oid'].find(
        alias => !columns.some(column => (column.name as string).toLowerCase() === alias)
      )
      if (!withoutRowid && implicitRowid === undefined) invalid()
      const keyColumns = withoutRowid
        ? columns
            .filter(column => (column.pk as number) > 0)
            .sort((a, b) => (a.pk as number) - (b.pk as number))
            .map(column => identifier(column.name))
        : [implicitRowid!]
      if (
        keyColumns.length < 1 ||
        keyColumns.length > 8 ||
        (withoutRowid &&
          keyColumns.some((_key, index) => columns.find(column => column.name === keyColumns[index])?.pk !== index + 1))
      )
        invalid()
      type Key = Readonly<{ name: string; kind: 'integer' | 'text'; value: string }>
      let previousKey: readonly Key[] | undefined
      for (;;) {
        check()
        const rowQuery = k(name)
          .select(
            ...keyColumns.flatMap((field, index) => [
              k.raw('typeof(??) AS ??', [field, `imageKeyType${index}`]),
              k.raw(
                "CASE WHEN typeof(??)='integer' THEN CAST(?? AS TEXT) WHEN typeof(??)='text' AND length(CAST(?? AS BLOB))<=128 THEN ?? END AS ??",
                [field, field, field, field, field, `imageKeyValue${index}`]
              )
            ])
          )
          .limit(1)
        for (const field of keyColumns) rowQuery.orderBy(field)
        if (previousKey !== undefined) {
          const low = previousKey
          rowQuery.where(function () {
            for (let index = 0; index < low.length; index++)
              this.orWhere(function () {
                for (let prefix = 0; prefix < index; prefix++)
                  this.whereRaw(low[prefix].kind === 'integer' ? '??=CAST(? AS INTEGER)' : '??=?', [
                    low[prefix].name,
                    low[prefix].value
                  ])
                this.whereRaw(low[index].kind === 'integer' ? '??>CAST(? AS INTEGER)' : '??>?', [
                  low[index].name,
                  low[index].value
                ])
              })
          })
        }
        const rowKeys = (await rowQuery) as Array<Record<string, unknown>>
        check()
        if (rowKeys.length === 0) break
        if (rowKeys.length !== 1 || ++rows > maximumBytes) invalid()
        const key: Key[] = keyColumns.map((field, index) => {
            const kind = rowKeys[0][`imageKeyType${index}`],
              value = rowKeys[0][`imageKeyValue${index}`]
            if (
              !(kind === 'integer' || (withoutRowid && kind === 'text')) ||
              typeof value !== 'string' ||
              Buffer.byteLength(value) > 128
            )
              invalid()
            if (kind === 'integer') signed(value)
            return Object.freeze({ name: field, kind, value })
          }),
          selectRow = (): Knex.QueryBuilder => {
            const query = k(name)
            for (const coordinate of key)
              query.whereRaw(coordinate.kind === 'integer' ? '??=CAST(? AS INTEGER)' : '??=?', [
                coordinate.name,
                coordinate.value
              ])
            return query
          }
        if (previousKey !== undefined && JSON.stringify(previousKey) === JSON.stringify(key)) invalid()
        add(['row', key.map(coordinate => [coordinate.kind, coordinate.value])])
        for (const column of columns) {
          const field = identifier(column.name),
            metadata = (await selectRow()
              .select(
                k.raw('typeof(??) AS imageType', [field]),
                k.raw('CASE WHEN ?? IS NULL THEN 0 ELSE length(CAST(?? AS BLOB)) END AS imageBytes', [field, field]),
                k.raw(
                  "CASE WHEN typeof(??)='integer' THEN CAST(?? AS TEXT) WHEN typeof(??)='real' THEN printf('%!.26g',??) END AS imageNumber",
                  [field, field, field, field]
                )
              )
              .limit(2)) as Array<{ imageType: unknown; imageBytes: unknown; imageNumber: unknown }>
          check()
          const cell = metadata[0]
          if (
            metadata.length !== 1 ||
            !['null', 'integer', 'real', 'text', 'blob'].includes(cell.imageType as string) ||
            !Number.isSafeInteger(cell.imageBytes) ||
            (cell.imageBytes as number) < 0 ||
            (cell.imageBytes as number) > policy.maximumPhysicalBytes
          )
            invalid()
          add(['cell', field, cell.imageType])
          if (cell.imageType === 'null') {
            if (cell.imageBytes !== 0) invalid()
            continue
          }
          if (cell.imageType === 'integer' || cell.imageType === 'real') {
            if (typeof cell.imageNumber !== 'string' || cell.imageNumber.length > 64) invalid()
            if (cell.imageType === 'integer') signed(cell.imageNumber)
            else if (
              !/^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[+-]?[0-9]+)?$/i.test(cell.imageNumber) ||
              !Number.isFinite(Number(cell.imageNumber))
            )
              invalid()
            add(cell.imageNumber)
          } else {
            const bytes = cell.imageBytes as number
            add(bytes)
            cellBytes += BigInt(bytes)
            if (cellBytes > maximumBytes) invalid()
            for (let offset = 0; offset < bytes;) {
              check()
              const amount = Math.min(policy.maximumReadBytes, bytes - offset),
                chunks = (await selectRow()
                  .select(k.raw('substr(CAST(?? AS BLOB),?,?) AS imageChunk', [field, offset + 1, amount]))
                  .limit(2)) as Array<{ imageChunk: unknown }>
              check()
              if (
                chunks.length !== 1 ||
                !(chunks[0].imageChunk instanceof Uint8Array) ||
                chunks[0].imageChunk.byteLength !== amount
              )
                invalid()
              hash.update(chunks[0].imageChunk)
              offset += amount
              await yieldRead()
            }
            hash.update('\n')
          }
        }
        previousKey = key
        await yieldRead()
      }
      add(['end-table', name])
    }
    check()
    if (required.size !== 0) invalid()
    add(['end-image', schemaObjects, tables, rows.toString(), cellBytes.toString()])
    return Object.freeze({
      protocol: 'brc38-composed-database-image/v1',
      sha256: hash.digest('hex'),
      schemaObjects,
      tables,
      rows: rows.toString(),
      cellBytes: cellBytes.toString()
    })
  } finally {
    charge.close()
  }
}
