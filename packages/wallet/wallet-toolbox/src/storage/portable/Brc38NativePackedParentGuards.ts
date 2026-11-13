/** Fresh packed schema DATA only. Each fixed coordinate still queries its
 * actual parent and original marker predicate. This does not admit a source,
 * writer, row or generation; callers validate the complete installed family. */
export function brc38NativePackedParentGuards(
  kind: 'binary' | 'text',
  definitions: readonly string[]
): readonly string[] {
  const prefix = `brc38_native_${kind}_fields`,
    sources: readonly (readonly [number, string, string])[] =
      kind === 'binary'
        ? [
            [0, 'transactions', 'transactionId'],
            [1, 'proven_txs', 'provenTxId'],
            [2, 'proven_tx_reqs', 'provenTxReqId'],
            [3, 'outputs', 'outputId'],
            [4, 'commissions', 'commissionId'],
            [8, 'prepared_beefs', 'preparedBeefId'],
            [9, 'action_batch_blobs', 'actionBatchBlobId'],
            [10, 'sync_transfer_parts', 'rowid'],
            [14, 'snapshot_reconciliation_stage_pages', 'rowid'],
            [15, 'snapshot_reconciliation_provenance', 'rowid']
          ]
        : [
            [0, 'transactions', 'transactionId'],
            [2, 'proven_tx_reqs', 'provenTxReqId'],
            [3, 'outputs', 'outputId'],
            [4, 'commissions', 'commissionId'],
            [5, 'sync_states', 'syncStateId'],
            [6, 'certificates', 'certificateId'],
            [7, 'certificate_fields', 'rowid'],
            [11, 'action_batches', 'actionBatchId'],
            [12, 'sync_transfers', 'slot'],
            [13, 'monitor_events', 'id']
          ],
    baseCount = kind === 'binary' ? 5 : 7,
    label = (id: number): string =>
      kind === 'text' && sources.slice(0, baseCount).some(source => source[0] === id) ? 'text field' : 'field',
    rowError = (id: number): string => `Packed native ${label(id)} has no actual metadata row`,
    moveError = (id: number): string => `Packed native ${label(id)} move has no actual metadata key transition`,
    rows = new Map<number, { table: string; key: string; marker: string }>(),
    moves = new Map<number, string>(),
    unrelated: string[] = []
  for (const sql of definitions) {
    const name = /^CREATE TRIGGER ([A-Za-z0-9_]+) /.exec(sql)?.[1]
    if (name?.startsWith(`${prefix}_row_`)) {
      const id = Number(name.slice(`${prefix}_row_`.length)),
        source = sources.find(value => value[0] === id),
        match =
          /SELECT CASE WHEN NOT EXISTS\(SELECT 1 FROM ([A-Za-z0-9_]+) w WHERE w\.([A-Za-z0-9_]+)=NEW\.rowId AND \((.+)\)\) THEN /.exec(
            sql
          )
      if (source === undefined || rows.has(id) || match === null || match[1] !== source[1] || match[2] !== source[2])
        throw new Error('Packed parent guard DATA differs')
      const expected = `CREATE TRIGGER ${prefix}_row_${id} BEFORE INSERT ON ${prefix} WHEN NEW.tableId=${id} BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ${match[1]} w WHERE w.${match[2]}=NEW.rowId AND (${match[3]})) THEN RAISE(ABORT,'${rowError(id)}') END; END`
      if (sql !== expected) throw new Error('Packed parent guard DATA differs')
      rows.set(id, { table: match[1], key: match[2], marker: match[3] })
    } else if (name?.startsWith(`${prefix}_move_`)) {
      const id = Number(name.slice(`${prefix}_move_`.length))
      if (!sources.some(value => value[0] === id) || moves.has(id)) throw new Error('Packed parent guard DATA differs')
      moves.set(id, sql)
    } else unrelated.push(sql)
  }
  const selected = sources.filter(value => rows.has(value[0]))
  if (
    !(selected.length === baseCount || selected.length === sources.length) ||
    moves.size !== rows.size ||
    sources.slice(0, selected.length).some(value => !rows.has(value[0]))
  )
    throw new Error('Packed parent guard DATA is incomplete')
  const groups = new Map<string, Array<readonly [number, string, string]>>()
  for (const source of selected) {
    const id = source[0],
      row = rows.get(id)!
    const expected = `CREATE TRIGGER ${prefix}_move_${id} BEFORE UPDATE ON ${prefix} WHEN NEW.tableId=${id} BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM ${row.table} w WHERE w.${row.key}=OLD.rowId) OR NOT EXISTS(SELECT 1 FROM ${row.table} w WHERE w.${row.key}=NEW.rowId AND (${row.marker})) THEN RAISE(ABORT,'${moveError(id)}') END; END`
    if (moves.get(id) !== expected) throw new Error('Packed parent move guard DATA differs')
    const group = groups.get(label(id)) ?? []
    group.push(source)
    groups.set(label(id), group)
  }
  for (const group of groups.values()) {
    const id = group[0][0],
      current: string[] = [],
      prior: string[] = []
    for (const [coordinate] of group) {
      const row = rows.get(coordinate)!
      current.push(
        `SELECT 1 FROM ${row.table} w WHERE NEW.tableId=${coordinate} AND w.${row.key}=NEW.rowId AND (${row.marker})`
      )
      prior.push(`SELECT 1 FROM ${row.table} w WHERE NEW.tableId=${coordinate} AND w.${row.key}=OLD.rowId`)
    }
    const ids = group.map(source => source[0]).join(','),
      exists = current.join(' UNION ALL '),
      existed = prior.join(' UNION ALL ')
    unrelated.push(
      `CREATE TRIGGER ${prefix}_row_${id} BEFORE INSERT ON ${prefix} WHEN NEW.tableId IN (${ids}) BEGIN SELECT CASE WHEN NOT EXISTS(${exists}) THEN RAISE(ABORT,'${rowError(id)}') END; END`,
      `CREATE TRIGGER ${prefix}_move_${id} BEFORE UPDATE ON ${prefix} WHEN NEW.tableId IN (${ids}) BEGIN SELECT CASE WHEN EXISTS(${existed}) OR NOT EXISTS(${exists}) THEN RAISE(ABORT,'${moveError(id)}') END; END`
    )
  }
  return Object.freeze(unrelated)
}
