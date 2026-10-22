/** Migration-owned trigger definitions; source indexes and rows are preserved. */
export interface SnapshotGlobalIndexTrigger {
  name: string
  table: string
  timing: 'BEFORE' | 'AFTER'
  event: 'INSERT' | 'UPDATE' | 'DELETE'
  body: string
  sql: string
}
const edges = 'snapshot_global_edges',
  keys = 'snapshot_global_keys',
  guards = 'snapshot_global_guards'
export function snapshotGlobalIndexTriggers(isMysql: boolean): SnapshotGlobalIndexTrigger[] {
  const statements: SnapshotGlobalIndexTrigger[] = []
  const trigger = (
    name: string,
    table: string,
    timing: 'BEFORE' | 'AFTER',
    event: 'INSERT' | 'UPDATE' | 'DELETE',
    body: string,
    when?: string
  ): void => {
    const condition = isMysql && when !== undefined ? `IF ${when} THEN ` : ''
    const end = when !== undefined && isMysql ? ' END IF;' : ''
    const fullName = `snapshot_global_${name}`
    const fullBody = `BEGIN ${condition}${body}${end} END`
    let qualifier = ''
    if (isMysql) qualifier = ' FOR EACH ROW'
    else if (when !== undefined) qualifier = ' WHEN ' + when
    const sql = `CREATE TRIGGER ${fullName} ${timing} ${event} ON ${table}${qualifier} ${fullBody}`
    statements.push({
      name: fullName,
      table,
      timing,
      event,
      body: fullBody,
      sql
    })
  }
  const edgeInsert = (selection: string): string =>
    `INSERT INTO ${edges} (transactionId,requestId,tableId,rowId,userId) ${selection}${isMysql ? ' ON DUPLICATE KEY UPDATE transactionId = ' + edges + '.transactionId' : ' ON CONFLICT(transactionId,requestId,tableId,rowId) DO NOTHING'};`
  const ensureProof = (expression: string): string =>
    isMysql
      ? `INSERT INTO ${guards} (proofId,present) VALUES (${expression},0) ON DUPLICATE KEY UPDATE proofId=${guards}.proofId; UPDATE ${guards} g LEFT JOIN proven_txs p ON p.provenTxId=g.proofId SET g.present=(p.provenTxId IS NOT NULL) WHERE g.proofId=${expression};`
      : `INSERT INTO ${guards} (proofId,present) SELECT ${expression},0 WHERE ${expression} IS NOT NULL ON CONFLICT(proofId) DO NOTHING; UPDATE ${guards} SET present=EXISTS(SELECT 1 FROM proven_txs WHERE provenTxId=${expression}) WHERE proofId=${expression};`
  const guardPresence = `CASE WHEN NEW.tableId=0 THEN 1 ELSE (SELECT present FROM ${guards} WHERE proofId=NEW.rowId${isMysql ? ' FOR SHARE' : ''}) END`
  const increase = `INSERT INTO ${keys} (tableId,userId,rowId,refs,present) VALUES (NEW.tableId,NEW.userId,NEW.rowId,1,${guardPresence})${isMysql ? ' ON DUPLICATE KEY UPDATE refs=' + keys + '.refs+1' : ' ON CONFLICT(tableId,userId,rowId) DO UPDATE SET refs=refs+1'};`
  const countWhere = 'tableId=OLD.tableId AND userId=OLD.userId AND rowId=OLD.rowId'
  const collect = `DELETE FROM ${guards} WHERE proofId=OLD.rowId AND OLD.tableId=1 AND NOT EXISTS(SELECT 1 FROM ${keys} WHERE tableId=1 AND rowId=OLD.rowId);`
  trigger(
    'edge_delete',
    edges,
    'AFTER',
    'DELETE',
    `UPDATE ${keys} SET refs=refs-1 WHERE ${countWhere}; DELETE FROM ${keys} WHERE ${countWhere} AND refs=0; ${collect}`
  )
  trigger('edge_insert', edges, 'AFTER', 'INSERT', increase)
  const diff = (field: string): string =>
    isMysql ? `NOT (OLD.${field} <=> NEW.${field})` : `OLD.${field} IS NOT NEW.${field}`
  const txnChanged = ['transactionId', 'userId', 'txid', 'provenTxId'].map(diff).join(' OR ')
  const reqChanged = ['provenTxReqId', 'txid', 'provenTxId'].map(diff).join(' OR ')
  trigger('tx_delete', 'transactions', 'AFTER', 'DELETE', `DELETE FROM ${edges} WHERE transactionId=OLD.transactionId;`)
  trigger(
    'tx_before_update',
    'transactions',
    'BEFORE',
    'UPDATE',
    `DELETE FROM ${edges} WHERE transactionId=OLD.transactionId;`,
    txnChanged
  )
  trigger('req_delete', 'proven_tx_reqs', 'AFTER', 'DELETE', `DELETE FROM ${edges} WHERE requestId=OLD.provenTxReqId;`)
  trigger(
    'req_before_update',
    'proven_tx_reqs',
    'BEFORE',
    'UPDATE',
    `DELETE FROM ${edges} WHERE requestId=OLD.provenTxReqId;`,
    reqChanged
  )
  const proofPresence = (prefix: 'OLD' | 'NEW', present: 0 | 1): string => {
    const merge = isMysql
      ? ` ON DUPLICATE KEY UPDATE present=${present}`
      : ` ON CONFLICT(proofId) DO UPDATE SET present=${present}`
    return `INSERT INTO ${guards} (proofId,present) VALUES (${prefix}.provenTxId,${present})${merge}; UPDATE ${keys} SET present=${present} WHERE tableId=1 AND rowId=${prefix}.provenTxId; DELETE FROM ${guards} WHERE proofId=${prefix}.provenTxId AND NOT EXISTS(SELECT 1 FROM ${keys} WHERE tableId=1 AND rowId=${prefix}.provenTxId);`
  }
  trigger('proof_delete', 'proven_txs', 'AFTER', 'DELETE', proofPresence('OLD', 0))
  trigger('proof_before_update', 'proven_txs', 'BEFORE', 'UPDATE', proofPresence('OLD', 0), diff('provenTxId'))
  trigger('proof_insert', 'proven_txs', 'AFTER', 'INSERT', proofPresence('NEW', 1))
  trigger('proof_after_update', 'proven_txs', 'AFTER', 'UPDATE', proofPresence('NEW', 1), diff('provenTxId'))
  let txnBody: string,
    declarations = ''
  if (isMysql) {
    declarations =
      'DECLARE requestedId INT UNSIGNED DEFAULT NULL; DECLARE requestedProof INT UNSIGNED DEFAULT NULL; DECLARE CONTINUE HANDLER FOR NOT FOUND BEGIN SET requestedId=NULL; SET requestedProof=NULL; END; '
    txnBody = `IF NEW.provenTxId IS NOT NULL THEN ${ensureProof('NEW.provenTxId')} ${edgeInsert('VALUES (NEW.transactionId,0,1,NEW.provenTxId,NEW.userId)')} END IF; SELECT provenTxReqId,provenTxId INTO requestedId,requestedProof FROM proven_tx_reqs WHERE txid=NEW.txid FOR SHARE; IF requestedId IS NOT NULL THEN ${edgeInsert('VALUES (NEW.transactionId,requestedId,0,requestedId,NEW.userId)')} IF requestedProof IS NOT NULL THEN ${ensureProof('requestedProof')} ${edgeInsert('VALUES (NEW.transactionId,requestedId,1,requestedProof,NEW.userId)')} END IF; END IF;`
  } else {
    const reqProof = '(SELECT provenTxId FROM proven_tx_reqs WHERE txid=NEW.txid)'
    txnBody = `${ensureProof('NEW.provenTxId')} ${ensureProof(reqProof)} ${edgeInsert('SELECT NEW.transactionId,0,1,NEW.provenTxId,NEW.userId WHERE NEW.provenTxId IS NOT NULL')} ${edgeInsert('SELECT NEW.transactionId,provenTxReqId,0,provenTxReqId,NEW.userId FROM proven_tx_reqs WHERE txid=NEW.txid')} ${edgeInsert('SELECT NEW.transactionId,provenTxReqId,1,provenTxId,NEW.userId FROM proven_tx_reqs WHERE txid=NEW.txid AND provenTxId IS NOT NULL')}`
  }
  // DECLARE belongs before the optional IF in a MySQL trigger body.
  trigger('tx_insert', 'transactions', 'AFTER', 'INSERT', declarations + txnBody)
  if (isMysql)
    trigger(
      'tx_after_update',
      'transactions',
      'AFTER',
      'UPDATE',
      `${declarations} IF ${txnChanged} THEN ${txnBody} END IF;`
    )
  else trigger('tx_after_update', 'transactions', 'AFTER', 'UPDATE', txnBody, txnChanged)
  const current = isMysql ? ' FOR SHARE' : ''
  const ensureReqProof = isMysql
    ? `IF NEW.provenTxId IS NOT NULL THEN ${ensureProof('NEW.provenTxId')} END IF;`
    : ensureProof('NEW.provenTxId')
  const requestEdges = `SELECT transactionId,NEW.provenTxReqId,0,NEW.provenTxReqId,userId FROM transactions WHERE txid=NEW.txid ORDER BY transactionId${current}`
  const proofEdges = `SELECT transactionId,NEW.provenTxReqId,1,NEW.provenTxId,userId FROM transactions WHERE txid=NEW.txid AND NEW.provenTxId IS NOT NULL ORDER BY transactionId${current}`
  const reqBody = `${ensureReqProof} ${edgeInsert(requestEdges)} ${edgeInsert(proofEdges)} DELETE FROM ${guards} WHERE proofId=NEW.provenTxId AND NOT EXISTS(SELECT 1 FROM ${keys} WHERE tableId=1 AND rowId=NEW.provenTxId);`
  trigger('req_insert', 'proven_tx_reqs', 'AFTER', 'INSERT', reqBody)
  trigger('req_after_update', 'proven_tx_reqs', 'AFTER', 'UPDATE', reqBody, reqChanged)
  return statements
}
