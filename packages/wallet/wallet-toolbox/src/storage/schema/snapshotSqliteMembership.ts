import { snapshotSqliteCellsChanged } from './snapshotSqliteCellComparison'
import {
  observeIdentity,
  observeSharedIdentity,
  displacedIdentity,
  finishIdentity,
  retirementProjection,
  sharedRetirementProjection,
  finishSharedIdentity,
  type IdentityDefinition,
  type SourceIdentity
} from './snapshotSqliteIdentity'

// Pure maintenance SQL shared by generation installation and focused fixture tests.
export const profiles = [
  'transactions',
  'outputs',
  'certificates',
  'tx_labels',
  'output_baskets',
  'output_tags',
  'commissions',
  'sync_states'
]
export const numeric: SourceIdentity[] = [
  { table: 'transactions', key: 'transactionId', owner: 'userId' },
  { table: 'outputs', key: 'outputId', owner: 'userId' },
  { table: 'certificates', key: 'certificateId', owner: 'userId' },
  { table: 'tx_labels', key: 'txLabelId', owner: 'userId' },
  { table: 'output_baskets', key: 'basketId', owner: 'userId' },
  { table: 'output_tags', key: 'outputTagId', owner: 'userId' },
  { table: 'commissions', key: 'commissionId', owner: 'userId' },
  { table: 'sync_states', key: 'syncStateId', owner: 'userId' },
  { table: 'proven_txs', key: 'provenTxId' },
  { table: 'proven_tx_reqs', key: 'provenTxReqId' }
]
export const relations = [
  {
    table: 'tx_labels_map',
    left: 'tx_labels',
    leftKey: 'txLabelId',
    right: 'transactions',
    rightKey: 'transactionId'
  },
  {
    table: 'output_tags_map',
    left: 'output_tags',
    leftKey: 'outputTagId',
    right: 'outputs',
    rightKey: 'outputId'
  }
]
type Event = 'INSERT' | 'UPDATE' | 'DELETE'
const q = (name: string): string => '"' + name.replaceAll('"', '""') + '"'
const relationColumns = 'snapshotTableId,snapshotUserId,snapshotLeftId,snapshotRightId'
const fieldColumns = 'snapshotUserId,snapshotFieldName,snapshotCertificateId'

export interface MembershipNames {
  profile: string
  relation: string
  certificate: string
  edges: string
  keys: string
  guards: string
}
export const legacyNames: MembershipNames = {
  profile: 'snapshot_profile_keys',
  relation: 'snapshot_relation_keys',
  certificate: 'snapshot_certificate_field_keys',
  edges: 'snapshot_global_edges',
  keys: 'snapshot_global_keys',
  guards: 'snapshot_global_guards'
}
export function membershipBodies(
  names: MembershipNames = legacyNames,
  reduced = false,
  shared = false,
  compactKeys = false
) {
  function relationInsert(select: string, bit: number): string {
    return `INSERT INTO ${names.relation}(${relationColumns},snapshotMembership) ${select} ON CONFLICT(${relationColumns}) DO UPDATE SET snapshotMembership=snapshotMembership|${bit}; `
  }
  function fieldInsert(select: string, bit: number): string {
    return `INSERT INTO ${names.certificate}(${fieldColumns},snapshotMembership) ${select} ON CONFLICT(${fieldColumns}) DO UPDATE SET snapshotMembership=snapshotMembership|${bit}; `
  }
  function edgeInsert(select: string): string {
    return `INSERT INTO ${names.edges}(transactionId,requestId,tableId,rowId,userId) ${select} ON CONFLICT(transactionId,requestId,tableId,rowId) DO NOTHING; `
  }
  function ensureProof(expression: string): string {
    return `INSERT INTO ${names.guards}(proofId,present) SELECT ${expression},EXISTS(SELECT 1 FROM proven_txs WHERE provenTxId=${expression}) WHERE ${expression} IS NOT NULL ON CONFLICT(proofId) DO UPDATE SET present=excluded.present; `
  }

  function ensureSelectedProof(expression: string, from: string, where: string): string {
    return `INSERT INTO ${names.guards}(proofId,present) SELECT ${expression},EXISTS(SELECT 1 FROM proven_txs p WHERE p.provenTxId=${expression}) FROM ${from} WHERE ${where} AND ${expression} IS NOT NULL ON CONFLICT(proofId) DO UPDATE SET present=excluded.present; `
  }

  function profileMembership(table: string, key: string, context: string, owners: string): string {
    let sql = ''
    const profileId = profiles.indexOf(table)
    if (profileId !== -1) {
      sql += `DELETE FROM ${names.profile} WHERE snapshotTableId=${profileId} AND (snapshotUserId,snapshotRowId) IN (${owners}); `
      sql += `INSERT INTO ${names.profile}(snapshotTableId,snapshotUserId,snapshotRowId) SELECT ${profileId},userId,${q(key)} FROM ${q(table)} WHERE ${q(key)}=${context}.${q(key)} ON CONFLICT(snapshotTableId,snapshotUserId,snapshotRowId) DO NOTHING; `
    }
    return sql
  }
  function parentMembership(table: string, key: string, context: string, owners: string): string {
    let sql = ''
    for (const [id, relation] of relations.entries())
      for (const side of ['left', 'right'] as const) {
        if (relation[side] !== table) continue
        const bit = side === 'left' ? 1 : 2
        const index = side === 'left' ? 'snapshotLeftId' : 'snapshotRightId'
        const where = `snapshotTableId=${id} AND (snapshotUserId,${index}) IN (${owners})`
        sql += `UPDATE ${names.relation} SET snapshotMembership=snapshotMembership&${3 ^ bit} WHERE ${where}; DELETE FROM ${names.relation} WHERE ${where} AND snapshotMembership=0; `
        sql += relationInsert(
          `SELECT ${id},p.userId,m.${relation.leftKey},m.${relation.rightKey},${bit} FROM ${q(table)} p JOIN ${relation.table} m ON m.${key}=p.${key} WHERE p.${key}=${context}.${key}`,
          bit
        )
      }
    if (table === 'certificates') {
      const where = `(snapshotUserId,snapshotCertificateId) IN (${owners})`
      sql += `UPDATE ${names.certificate} SET snapshotMembership=snapshotMembership&1 WHERE ${where}; DELETE FROM ${names.certificate} WHERE ${where} AND snapshotMembership=0; `
      sql += fieldInsert(
        `SELECT c.userId,f.fieldName,f.certificateId,2 FROM certificates c JOIN ${names.certificate} k ON k.snapshotCertificateId=c.certificateId AND (k.snapshotMembership&1)=1 JOIN certificate_fields f ON f.fieldName=k.snapshotFieldName AND f.certificateId=k.snapshotCertificateId WHERE c.certificateId=${context}.certificateId`,
        2
      )
    }
    return sql
  }
  function globalMembership(table: string, context: string, ids: string): string {
    let sql = ''
    if (table === 'transactions') {
      sql += `DELETE FROM ${names.edges} WHERE transactionId IN (${ids}); `
      sql += reduced
        ? ensureSelectedProof('t.provenTxId', 'transactions t', `t.transactionId=${context}.transactionId`)
        : ensureProof(`(SELECT provenTxId FROM transactions WHERE transactionId=${context}.transactionId)`)
      sql += reduced
        ? ensureSelectedProof(
            'r.provenTxId',
            'transactions t JOIN proven_tx_reqs r ON r.txid=t.txid',
            `t.transactionId=${context}.transactionId`
          )
        : ensureProof(
            `(SELECT r.provenTxId FROM transactions t JOIN proven_tx_reqs r ON r.txid=t.txid WHERE t.transactionId=${context}.transactionId)`
          )
      sql += edgeInsert(
        `SELECT t.transactionId,0,1,t.provenTxId,t.userId FROM transactions t WHERE t.transactionId=${context}.transactionId AND t.provenTxId IS NOT NULL`
      )
      sql += edgeInsert(
        `SELECT t.transactionId,r.provenTxReqId,0,r.provenTxReqId,t.userId FROM transactions t JOIN proven_tx_reqs r ON r.txid=t.txid WHERE t.transactionId=${context}.transactionId`
      )
      sql += edgeInsert(
        `SELECT t.transactionId,r.provenTxReqId,1,r.provenTxId,t.userId FROM transactions t JOIN proven_tx_reqs r ON r.txid=t.txid WHERE t.transactionId=${context}.transactionId AND r.provenTxId IS NOT NULL`
      )
    }
    if (table === 'proven_tx_reqs') {
      sql += `DELETE FROM ${names.edges} WHERE requestId IN (${ids}); `
      const proof = `(SELECT provenTxId FROM proven_tx_reqs WHERE provenTxReqId=${context}.provenTxReqId)`
      sql += reduced
        ? ensureSelectedProof('r.provenTxId', 'proven_tx_reqs r', `r.provenTxReqId=${context}.provenTxReqId`)
        : ensureProof(proof)
      sql += edgeInsert(
        `SELECT t.transactionId,r.provenTxReqId,0,r.provenTxReqId,t.userId FROM proven_tx_reqs r JOIN transactions t ON t.txid=r.txid WHERE r.provenTxReqId=${context}.provenTxReqId`
      )
      sql += edgeInsert(
        `SELECT t.transactionId,r.provenTxReqId,1,r.provenTxId,t.userId FROM proven_tx_reqs r JOIN transactions t ON t.txid=r.txid WHERE r.provenTxReqId=${context}.provenTxReqId AND r.provenTxId IS NOT NULL`
      )
      sql += `DELETE FROM ${names.guards} WHERE proofId=${proof} AND NOT EXISTS(SELECT 1 FROM ${names.keys} WHERE tableId=1 AND rowId=proofId); `
    }
    if (table === 'proven_txs') {
      sql += `UPDATE ${names.guards} SET present=0 WHERE proofId IN (${ids}); UPDATE ${names.keys} SET present=0 WHERE tableId=1 AND rowId IN (${ids}); DELETE FROM ${names.guards} WHERE proofId IN (${ids}) AND NOT EXISTS(SELECT 1 FROM ${names.keys} WHERE tableId=1 AND rowId=proofId); `
      sql += `UPDATE ${names.guards} SET present=1 WHERE proofId=${context}.provenTxId AND EXISTS(SELECT 1 FROM proven_txs WHERE provenTxId=${context}.provenTxId); UPDATE ${names.keys} SET present=1 WHERE tableId=1 AND rowId=${context}.provenTxId AND EXISTS(SELECT 1 FROM proven_txs WHERE provenTxId=${context}.provenTxId); `
    }
    return sql
  }

  function numericMembership(d: IdentityDefinition, event: Event): string {
    const { table, key, owner } = d.source
    const context = shared ? 'NEW' : event === 'DELETE' ? 'OLD' : 'NEW'
    const ownerColumn = owner ? ',OLD.' + q(owner) + ' AS ' + q(owner) : ''
    const retired =
      event === 'DELETE' ? `SELECT OLD.${q(key)} AS ${q(key)}${ownerColumn}` : displacedIdentity(d, event === 'UPDATE')
    const ids = shared
      ? sharedRetirementProjection(d, false)
      : reduced
        ? retirementProjection(d, event, false)
        : `SELECT ${q(key)} FROM (${retired})`
    const owners = owner
      ? shared
        ? sharedRetirementProjection(d, true)
        : reduced
          ? retirementProjection(d, event, true)
          : `SELECT ${q(owner)},${q(key)} FROM (${retired})`
      : ''
    const sql =
      profileMembership(table, key, context, owners) +
      parentMembership(table, key, context, owners) +
      globalMembership(table, context, ids)
    return sql + (shared ? finishSharedIdentity(d, compactKeys) : finishIdentity(d, event))
  }

  function compositeMembership(table: string, event: Event): string {
    const context = event === 'DELETE' ? 'OLD' : 'NEW'
    const contexts = event === 'UPDATE' ? ['OLD', 'NEW'] : [context]
    if (table === 'certificate_fields') {
      let sql = contexts
        .map(
          value =>
            `DELETE FROM ${names.certificate} WHERE snapshotFieldName=${value}.fieldName AND snapshotCertificateId=${value}.certificateId; `
        )
        .join('')
      sql += fieldInsert(
        `SELECT userId,fieldName,certificateId,1 FROM certificate_fields WHERE fieldName=${context}.fieldName AND certificateId=${context}.certificateId`,
        1
      )
      sql += fieldInsert(
        `SELECT c.userId,f.fieldName,f.certificateId,2 FROM certificate_fields f JOIN certificates c ON c.certificateId=f.certificateId WHERE f.fieldName=${context}.fieldName AND f.certificateId=${context}.certificateId`,
        2
      )
      return sql
    }
    const id = relations.findIndex(relation => relation.table === table)
    const relation = relations[id]
    let sql = contexts
      .map(
        value =>
          `DELETE FROM ${names.relation} WHERE snapshotTableId=${id} AND snapshotLeftId=${value}.${relation.leftKey} AND snapshotRightId=${value}.${relation.rightKey}; `
      )
      .join('')
    for (const side of ['left', 'right'] as const) {
      const key = side === 'left' ? relation.leftKey : relation.rightKey
      const bit = side === 'left' ? 1 : 2
      sql += relationInsert(
        `SELECT ${id},p.userId,m.${relation.leftKey},m.${relation.rightKey},${bit} FROM ${table} m JOIN ${relation[side]} p ON p.${key}=m.${key} WHERE m.${relation.leftKey}=${context}.${relation.leftKey} AND m.${relation.rightKey}=${context}.${relation.rightKey}`,
        bit
      )
    }
    return sql
  }

  return { numeric: numericMembership, composite: compositeMembership }
}

function changed(columns: string[], native = false): string {
  return snapshotSqliteCellsChanged(columns, native)
}

function numericTriggers(d: IdentityDefinition, bodies: ReturnType<typeof membershipBodies>): string[] {
  const sql: string[] = []
  const fields = d.columns.map(column => column.name)
  if (d.source.table === 'transactions') fields.push('txid', 'provenTxId')
  if (d.source.table === 'proven_tx_reqs') fields.push('provenTxId')
  for (const event of ['INSERT', 'UPDATE', 'DELETE'] as const) {
    const when = event === 'UPDATE' ? ' WHEN ' + changed(fields) : ''
    if (event !== 'DELETE')
      sql.push(
        `CREATE TRIGGER ${q('snapshot_identity_before_' + d.source.table + '_' + event)} BEFORE ${event} ON ${q(d.source.table)}${when} BEGIN ${observeIdentity(d, event === 'UPDATE')} END`
      )
    sql.push(
      `CREATE TRIGGER ${q('snapshot_identity_after_' + d.source.table + '_' + event)} AFTER ${event} ON ${q(d.source.table)}${when} BEGIN ${bodies.numeric(d, event)} END`
    )
  }
  return sql
}

export function membershipTriggers(
  definitions: IdentityDefinition[],
  names: MembershipNames = legacyNames,
  reduced = false
): string[] {
  const sql: string[] = []
  const bodies = membershipBodies(names, reduced)
  for (const d of definitions) sql.push(...numericTriggers(d, bodies))
  for (const table of [...relations.map(relation => relation.table), 'certificate_fields']) {
    const relation = relations.find(relation => relation.table === table)
    const fields = relation ? [relation.leftKey, relation.rightKey] : ['fieldName', 'certificateId', 'userId']
    for (const event of ['INSERT', 'UPDATE', 'DELETE'] as const) {
      const when = event === 'UPDATE' ? ' WHEN ' + changed(fields) : ''
      sql.push(
        `CREATE TRIGGER ${q('snapshot_identity_after_' + table + '_' + event)} AFTER ${event} ON ${q(table)}${when} BEGIN ${bodies.composite(table, event)} END`
      )
    }
  }
  return sql
}

/** Complete fresh-native layout. Views retain no rows or roots. Original
 * BEFORE witnesses and AFTER event order remain; one handler contains the
 * original membership statements with event-specific retirement predicates. */
export function sharedMembershipTriggers(
  definitions: IdentityDefinition[],
  names: MembershipNames = legacyNames,
  completeEvents = false,
  nativeCells = false,
  compactKeys = false
): string[] {
  const sql: string[] = [],
    bodies = membershipBodies(names, true, true, compactKeys)
  for (const d of definitions) {
    const view = 'snapshot_identity_events_' + d.source.table,
      handler = 'snapshot_identity_apply_' + d.source.table,
      columns = [
        ...(completeEvents ? ['phase'] : []),
        'event',
        d.source.key,
        ...d.columns.map((_, index) => 'n' + index),
        ...d.columns.map((_, index) => 'o' + index)
      ],
      fields = d.columns.map(column => column.name)
    if (d.source.table === 'transactions') fields.push('txid', 'provenTxId')
    if (d.source.table === 'proven_tx_reqs') fields.push('provenTxId')
    sql.push(
      `CREATE VIEW ${q(view)} (${columns.map(q).join(',')}) AS SELECT ${columns.map(() => 'NULL').join(',')} WHERE 0`
    )
    sql.push(
      `CREATE TRIGGER ${q(handler)} INSTEAD OF INSERT ON ${q(view)}${completeEvents ? ' WHEN NEW.phase=1' : ''} BEGIN ${bodies.numeric(d, 'UPDATE')} END`
    )
    if (completeEvents)
      sql.push(
        `CREATE TRIGGER ${q('snapshot_identity_apply_before_' + d.source.table)} INSTEAD OF INSERT ON ${q(view)} WHEN NEW.phase=0 BEGIN ${observeSharedIdentity(d, compactKeys)} END`
      )
    for (const [ordinal, event] of (['INSERT', 'UPDATE', 'DELETE'] as const).entries()) {
      const when = event === 'UPDATE' ? ' WHEN ' + changed(fields, nativeCells) : '',
        prefix = event === 'DELETE' ? 'OLD' : 'NEW',
        values = [
          String(ordinal + 1),
          `${prefix}.${q(d.source.key)}`,
          ...d.columns.map(column => (event === 'DELETE' ? 'NULL' : `NEW.${q(column.name)}`)),
          ...d.columns.map(column => (event === 'INSERT' ? 'NULL' : `OLD.${q(column.name)}`))
        ]
      if (event !== 'DELETE')
        sql.push(
          `CREATE TRIGGER ${q('snapshot_identity_before_' + d.source.table + '_' + event)} BEFORE ${event} ON ${q(d.source.table)}${when} BEGIN ${completeEvents ? `INSERT INTO ${q(view)} VALUES(0,${values.join(',')});` : observeIdentity(d, event === 'UPDATE')} END`
        )
      sql.push(
        `CREATE TRIGGER ${q('snapshot_identity_after_' + d.source.table + '_' + event)} AFTER ${event} ON ${q(d.source.table)}${when} BEGIN INSERT INTO ${q(view)} VALUES(${completeEvents ? '1,' : ''}${values.join(',')}); END`
      )
    }
  }
  if (completeEvents) {
    for (const table of [...relations.map(relation => relation.table), 'certificate_fields']) {
      const relation = relations.find(relation => relation.table === table),
        fields = relation ? [relation.leftKey, relation.rightKey] : ['fieldName', 'certificateId', 'userId'],
        view = 'snapshot_identity_events_' + table,
        columns = ['event', ...fields.map((_, index) => 'n' + index), ...fields.map((_, index) => 'o' + index)]
      // Preserve the UPDATE statement order: old retirement, current
      // retirement, then actual current-source membership inserts. INSERT and
      // DELETE carry NULL old-key cells, so their extra old retirement matches
      // no row under the original non-NULL composite-key contract. DELETE's
      // current cells are the actual OLD key; the live-source SELECT remains.
      let body = bodies.composite(table, 'UPDATE')
      for (const [index, field] of fields.entries()) {
        body = body.replaceAll('OLD.' + field, 'NEW.o' + index).replaceAll('NEW.' + field, 'NEW.n' + index)
      }
      sql.push(
        `CREATE VIEW ${q(view)} (${columns.map(q).join(',')}) AS SELECT ${columns.map(() => 'NULL').join(',')} WHERE 0`
      )
      sql.push(
        `CREATE TRIGGER ${q('snapshot_identity_apply_' + table)} INSTEAD OF INSERT ON ${q(view)} BEGIN ${body} END`
      )
      for (const [ordinal, event] of (['INSERT', 'UPDATE', 'DELETE'] as const).entries()) {
        const when = event === 'UPDATE' ? ' WHEN ' + changed(fields, nativeCells) : '',
          prefix = event === 'DELETE' ? 'OLD' : 'NEW',
          cells = [
            String(ordinal + 1),
            ...fields.map(field => `${prefix}.${q(field)}`),
            ...fields.map(field => (event === 'UPDATE' ? `OLD.${q(field)}` : 'NULL'))
          ]
        sql.push(
          `CREATE TRIGGER ${q('snapshot_identity_after_' + table + '_' + event)} AFTER ${event} ON ${q(table)}${when} BEGIN INSERT INTO ${q(view)} VALUES(${cells.join(',')}); END`
        )
      }
    }
    return sql
  }
  // Composite keys have their own unchanged point observers.
  const numericPrefix = new Set(definitions.map(d => 'snapshot_identity_' + d.source.table))
  const composite = membershipTriggers(definitions, names, true).filter(value => {
    const match = /^CREATE TRIGGER "snapshot_identity_(?:before|after)_([^" ]+)_(?:INSERT|UPDATE|DELETE)"/.exec(value)
    return match === null || !numericPrefix.has('snapshot_identity_' + match[1])
  })
  return [...sql, ...composite]
}
