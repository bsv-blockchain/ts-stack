export const brc38NativeLocalPackedLayoutMigration = '2026-10-07-005 empty private local packed receiver'

/** Optional empty-candidate layout DATA. Auxiliary operational payloads are
 * private local state, never additions to the BRC-38 archive vocabulary. */
export const brc38NativeLocalPackedSources = Object.freeze([
  Object.freeze({
    id: 8,
    table: 'prepared_beefs',
    key: 'preparedBeefId',
    kind: 'binary' as const,
    fields: Object.freeze(['beef'])
  }),
  Object.freeze({
    id: 9,
    table: 'action_batch_blobs',
    key: 'actionBatchBlobId',
    kind: 'binary' as const,
    fields: Object.freeze(['bytes'])
  }),
  Object.freeze({
    id: 10,
    table: 'sync_transfer_parts',
    key: 'rowid',
    kind: 'binary' as const,
    fields: Object.freeze(['bytes'])
  }),
  Object.freeze({
    id: 11,
    table: 'action_batches',
    key: 'actionBatchId',
    kind: 'text' as const,
    fields: Object.freeze(['uploadDigests', 'result', 'manifest'])
  }),
  Object.freeze({
    id: 12,
    table: 'sync_transfers',
    key: 'slot',
    kind: 'text' as const,
    fields: Object.freeze(['result'])
  }),
  Object.freeze({
    id: 13,
    table: 'monitor_events',
    key: 'id',
    kind: 'text' as const,
    fields: Object.freeze(['details'])
  }),
  Object.freeze({
    id: 14,
    table: 'snapshot_reconciliation_stage_pages',
    key: 'rowid',
    kind: 'binary' as const,
    fields: Object.freeze(['payload'])
  }),
  Object.freeze({
    id: 15,
    table: 'snapshot_reconciliation_provenance',
    key: 'rowid',
    kind: 'binary' as const,
    fields: Object.freeze(['payload'])
  })
])
export const brc38NativeLocalPackedLayoutName = 'brc38_native_local_packed_layout'
export const brc38NativeLocalPackedLayoutDefinitions = Object.freeze([
  `CREATE TABLE brc38_native_local_packed_layout(slot INTEGER PRIMARY KEY CHECK(slot=1),protocol TEXT NOT NULL CHECK(protocol='brc38-native-local-packed/v2'))`,
  `CREATE TRIGGER brc38_native_local_packed_layout_update BEFORE UPDATE ON brc38_native_local_packed_layout BEGIN SELECT RAISE(ABORT,'Local packed layout is immutable'); END`,
  `CREATE TRIGGER brc38_native_local_packed_layout_delete BEFORE DELETE ON brc38_native_local_packed_layout BEGIN SELECT RAISE(ABORT,'Local packed layout requires owned profile retirement'); END`
])
/** Fresh schema DATA only. Payload chunks retain their physical rowid for
 * incremental BLOB I/O. Metadata owns one primary tree instead of duplicating
 * that tree in an implicit rowid table and an autoindex. Existing definitions
 * remain separate: callers select them from actual complete persisted SQL.
 * Only equivalent source marker predicates are grouped; individual field
 * clearing and every pointer/lifetime/quota guard remain intact. */
export function brc38NativeCompactPackedDefinitions(
  kind: 'binary' | 'text',
  source: readonly string[],
  literalMarkers = false
): readonly string[] {
  const prefix = `brc38_native_${kind}`,
    metadata = ['versions', 'fields', 'garbage'].map(suffix => `${prefix}_${suffix}`),
    result: string[] = [],
    groups = new Map<string, { table: string; event: string; fields: string[]; conditions: string[]; error: string }>()
  for (const original of source) {
    const table = /^CREATE TABLE ([A-Za-z0-9_]+)\(/.exec(original)
    if (table !== null && metadata.includes(table[1])) {
      result.push(original.endsWith(' WITHOUT ROWID') ? original : original + ' WITHOUT ROWID')
      continue
    }
    const guard =
      /^CREATE TRIGGER ([A-Za-z0-9_]+) BEFORE (INSERT|UPDATE OF ([A-Za-z0-9_]+)) ON ([A-Za-z0-9_]+) WHEN (NEW\.([A-Za-z0-9_]+) IS NOT NULL AND .+) BEGIN SELECT RAISE\(ABORT,'(Packed native (?:payload|text) requires its bounded field writer)'\); END$/.exec(
        original
      )
    if (
      guard === null ||
      guard[1] !== `${prefix}_${guard[4]}_${guard[6]}_${guard[2] === 'INSERT' ? 'insert' : 'update'}`
    ) {
      result.push(original)
      continue
    }
    const event = guard[2] === 'INSERT' ? 'INSERT' : 'UPDATE',
      key = `${guard[4]}:${event}`,
      group = groups.get(key) ?? { table: guard[4], event, fields: [], conditions: [], error: guard[7] }
    if (guard[3] !== undefined && guard[3] !== guard[6]) throw new Error('Packed marker source DATA differs')
    if (group.fields.includes(guard[6]) || group.error !== guard[7])
      throw new Error('Packed marker source DATA repeats')
    group.fields.push(guard[6])
    group.conditions.push(guard[5])
    groups.set(key, group)
  }
  for (const group of groups.values()) {
    const name = group.fields.length === 1 ? group.fields[0] : 'payload_markers',
      event = group.event === 'INSERT' ? 'INSERT' : `UPDATE OF ${group.fields.join(',')}`
    result.push(
      `CREATE TRIGGER ${prefix}_${group.table}_${name}_${group.event.toLowerCase()} BEFORE ${event} ON ${group.table} WHEN ${group.conditions.map(value => `(${value})`).join(' OR ')} BEGIN SELECT RAISE(ABORT,'${group.error}'); END`
    )
  }
  return literalMarkers ? brc38NativeLiteralPackedDefinitions(kind, result) : Object.freeze(result)
}
/** Source definitions only. Base persisted schemas keep their exact definitions
 * until an explicit empty private candidate installs this optional layout. */
export function brc38NativeLocalPackedFamilyDefinitions(
  kind: 'binary' | 'text',
  base: readonly string[],
  projectedPayloadQuota = false
): readonly string[] {
  const prefix = `brc38_native_${kind}`,
    fields = `${prefix}_fields`,
    condition =
      kind === 'binary'
        ? `(tableId=0 AND fieldId BETWEEN 0 AND 2) OR (tableId IN (1,2) AND fieldId BETWEEN 0 AND 1) OR (tableId IN (3,4,8,9,10,14,15) AND fieldId=0)`
        : `(tableId=0 AND fieldId BETWEEN 3 AND 5) OR (tableId=2 AND fieldId BETWEEN 2 AND 3) OR (tableId=3 AND fieldId BETWEEN 1 AND 7) OR (tableId=4 AND fieldId=1) OR (tableId=5 AND fieldId BETWEEN 0 AND 2) OR (tableId=6 AND fieldId BETWEEN 0 AND 3) OR (tableId=7 AND fieldId BETWEEN 0 AND 1) OR (tableId=11 AND fieldId BETWEEN 0 AND 2) OR (tableId IN (12,13) AND fieldId=0)`,
    ids = kind === 'binary' ? '0,1,2,3,4,8,9,10,14,15' : '0,2,3,4,5,6,7,11,12,13',
    result = base.map(sql =>
      sql.startsWith(`CREATE TABLE ${fields}(`)
        ? `CREATE TABLE ${fields}(tableId INTEGER NOT NULL CHECK(tableId IN (${ids})),rowId INTEGER NOT NULL CHECK(typeof(rowId)='integer' AND rowId BETWEEN -9007199254740991 AND 9007199254740991),fieldId INTEGER NOT NULL CHECK(${condition}),sha256 TEXT NOT NULL REFERENCES ${prefix}_versions(sha256),PRIMARY KEY(tableId,rowId,fieldId))`
        : sql
    )
  for (const source of brc38NativeLocalPackedSources.filter(value => value.kind === kind)) {
    const { id, table, key } = source,
      sqlKind = kind === 'binary' ? 'blob' : 'text',
      length = (value: string): string => (kind === 'binary' ? `length(${value})` : `length(CAST(${value} AS BLOB))`),
      marker = source.fields
        .map(
          (field, fieldId) =>
            `(NEW.fieldId=${fieldId} AND typeof(w.${field})='${sqlKind}' AND ${length(`w.${field}`)}=0)`
        )
        .join(' OR ')
    result.push(
      `CREATE TRIGGER ${fields}_row_${id} BEFORE INSERT ON ${fields} WHEN NEW.tableId=${id} BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ${table} w WHERE w.${key}=NEW.rowId AND (${marker})) THEN RAISE(ABORT,'Packed native field has no actual metadata row') END; END`,
      `CREATE TRIGGER ${prefix}_${table}_delete AFTER DELETE ON ${table} BEGIN DELETE FROM ${fields} WHERE tableId=${id} AND rowId=OLD.${key}; END`,
      `CREATE TRIGGER ${fields}_move_${id} BEFORE UPDATE ON ${fields} WHEN NEW.tableId=${id} BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM ${table} w WHERE w.${key}=OLD.rowId) OR NOT EXISTS(SELECT 1 FROM ${table} w WHERE w.${key}=NEW.rowId AND (${marker})) THEN RAISE(ABORT,'Packed native field move has no actual metadata key transition') END; END`,
      `CREATE TRIGGER ${prefix}_${table}_move AFTER UPDATE OF ${key} ON ${table} WHEN NEW.${key} IS NOT OLD.${key} BEGIN UPDATE ${fields} SET rowId=NEW.${key} WHERE tableId=${id} AND rowId=OLD.${key}; END`
    )
    for (const [fieldId, field] of source.fields.entries())
      result.push(
        `CREATE TRIGGER ${prefix}_${table}_${field}_insert BEFORE INSERT ON ${table} WHEN NEW.${field} IS NOT NULL AND (typeof(NEW.${field})!='${sqlKind}' OR ${length(`NEW.${field}`)}!=0) BEGIN SELECT RAISE(ABORT,'Packed native payload requires its bounded field writer'); END`,
        `CREATE TRIGGER ${prefix}_${table}_${field}_update BEFORE UPDATE OF ${field} ON ${table} WHEN NEW.${field} IS NOT NULL AND (typeof(NEW.${field})!='${sqlKind}' OR ${length(`NEW.${field}`)}!=0) BEGIN SELECT RAISE(ABORT,'Packed native payload requires its bounded field writer'); END`,
        `CREATE TRIGGER ${prefix}_${table}_${field}_clear AFTER UPDATE OF ${field} ON ${table} WHEN NEW.${field} IS NULL BEGIN DELETE FROM ${fields} WHERE tableId=${id} AND rowId=NEW.${key} AND fieldId=${fieldId}; END`
      )
  }
  if (kind === 'binary') result.push(...brc38NativeLocalJournalPayloadQuotaDefinitions(projectedPayloadQuota))
  return Object.freeze(result)
}
/** Preserve the shared journal's original logical payload charge. Metadata row
 * triggers still charge their physical cells and row overhead. Pointer changes
 * add/remove exactly four times the actual sealed payload bytes in the SAME
 * writer, including deletion after its metadata row has gone. Content reuse is
 * charged per reference, never used to bypass the original journal allowance. */
export function brc38NativeLocalJournalPayloadQuotaDefinitions(projected = false): readonly string[] {
  const quota = 'snapshot_reconciliation_shared_quota',
    versions = 'brc38_native_binary_versions',
    fields = 'brc38_native_binary_fields',
    result: string[] = []
  for (const id of [14, 15])
    for (const event of ['INSERT', 'UPDATE', 'DELETE'] as const) {
      const context = event === 'DELETE' ? 'OLD' : 'NEW',
        charge = (side: 'OLD' | 'NEW'): string =>
          `(4*(SELECT bytes FROM ${versions} WHERE sha256=${side}.sha256 AND state='SEALED' AND accepted=bytes))`,
        before = event === 'INSERT' ? '0' : charge('OLD'),
        after = event === 'DELETE' ? '0' : charge('NEW')
      // Each projection is exactly one row, including NULL for a missing or
      // unsealed version. Its WHERE retains the original failed-update/abort
      // behavior; no default value can manufacture a free payload reference.
      const selectedBefore = projected ? 'beforeBytes' : before,
        selectedAfter = projected ? 'afterBytes' : after,
        projection = projected ? ` FROM (SELECT ${before} AS beforeBytes,${after} AS afterBytes)` : ''
      result.push(
        `CREATE TRIGGER brc38_native_binary_journal_quota_${id}_${event.toLowerCase()} AFTER ${event} ON ${fields} WHEN ${context}.tableId=${id} BEGIN UPDATE ${quota} SET bytes=bytes-${selectedBefore}+${selectedAfter},changeBit=1-changeBit${projection} WHERE id=0 AND changeBit IN (0,1) AND bytes>=${selectedBefore} AND bytes-${selectedBefore}+${selectedAfter}<=byteLimit AND byteLimit=17179869184 AND rowLimit=2147483647; SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'Shared logical journal payload quota exhausted or inconsistent') END; END`
      )
    }
  return Object.freeze(result)
}

/** Equivalent marker DDL for fresh private schemas. SQLite IS compares storage
 * classes without coercion: X'' is exactly a zero-byte BLOB; a BINARY-collated
 * '' is exactly zero-byte TEXT, including under source RTRIM/NOCASE collations.
 * NULL handling remains in the original outer predicates. This transforms
 * source-owned trigger DATA only, never source rows or an admission verdict. */
export function brc38NativeLiteralPackedDefinitions(
  kind: 'binary' | 'text',
  source: readonly string[]
): readonly string[] {
  if (kind !== 'binary' && kind !== 'text') throw new Error('Packed marker family DATA differs')
  return Object.freeze(
    source.map(sql => {
      if (!sql.startsWith(`CREATE TRIGGER brc38_native_${kind}_`)) return sql
      return kind === 'binary'
        ? sql
            .replace(/typeof\((w|NEW)\.([A-Za-z_][A-Za-z0-9_]*)\)='blob' AND length\(\1\.\2\)=0/g, "$1.$2 IS X''")
            .replace(/typeof\((w|NEW)\.([A-Za-z_][A-Za-z0-9_]*)\)!='blob' OR length\(\1\.\2\)!=0/g, "$1.$2 IS NOT X''")
        : sql
            .replace(
              /typeof\((w|NEW)\.([A-Za-z_][A-Za-z0-9_]*)\)='text' AND length\(CAST\(\1\.\2 AS BLOB\)\)=0/g,
              "$1.$2 COLLATE BINARY IS ''"
            )
            .replace(
              /typeof\((w|NEW)\.([A-Za-z_][A-Za-z0-9_]*)\)!='text' OR length\(CAST\(\1\.\2 AS BLOB\)\)!=0/g,
              "$1.$2 COLLATE BINARY IS NOT ''"
            )
    })
  )
}
