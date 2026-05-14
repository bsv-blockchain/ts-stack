import { Knex } from 'knex'
import * as sdk from '../../sdk'
import {
  TableAction,
  TableChainTip,
  TableTransactionNew
} from './tables'
import { auditProcessingTransition } from './txAudit'

/** Read a single canonical `transactions` row by txid. */
export async function findTransactionNewByTxid (knex: Knex, txid: string): Promise<TableTransactionNew | undefined> {
  const row = await knex('transactions').where({ txid }).first()
  return row != null ? mapTransactionRow(row) : undefined
}

/**
 * Insert a canonical `transactions` row.
 * Returns the row's txid (the PK).
 */
export async function insertTransactionNew (
  knex: Knex,
  row: Omit<TableTransactionNew, 'created_at' | 'updated_at'>,
  now: Date = new Date()
): Promise<string> {
  await knex('transactions').insert(unmapTransactionRow(row, now))
  return row.txid
}

/**
 * Transition the processing column atomically and append a `tx_audit` row.
 * Returns the new `TableTransactionNew` on success and `undefined` when the
 * source state did not match the row (CAS failed) or the transition was
 * rejected by the FSM.
 */
export async function transitionProcessing (
  knex: Knex,
  args: {
    txid: string
    expectedFromState: sdk.ProcessingStatus
    toState: sdk.ProcessingStatus
    details?: Record<string, unknown>
    provider?: string
    providerStatus?: string
  },
  now: Date = new Date()
): Promise<TableTransactionNew | undefined> {
  const ok = await auditProcessingTransition(
    knex,
    args.txid,
    args.expectedFromState,
    args.toState,
    args.details,
    now
  )
  if (!ok) return undefined
  const updated = await knex('transactions')
    .where({ txid: args.txid, processing: args.expectedFromState })
    .update({
      processing: args.toState,
      processing_changed_at: now,
      last_provider: args.provider ?? null,
      last_provider_status: args.providerStatus ?? null,
      updated_at: now
    })
  if (updated === 0) return undefined
  const row = await knex('transactions').where({ txid: args.txid }).first()
  return mapTransactionRow(row)
}

/** Find an action row by `(userId, txid)`. */
export async function findActionByTxid (
  knex: Knex,
  userId: number,
  txid: string
): Promise<TableAction | undefined> {
  const row = await knex('actions').where({ userId, txid }).first()
  return row != null ? mapActionRow(row) : undefined
}

/** Find an action row by `actionId`. */
export async function findActionById (
  knex: Knex,
  actionId: number
): Promise<TableAction | undefined> {
  const row = await knex('actions').where({ actionId }).first()
  return row != null ? mapActionRow(row) : undefined
}

/** Insert an `actions` row and return the assigned `actionId`. */
export async function insertAction (
  knex: Knex,
  row: Omit<TableAction, 'actionId' | 'created_at' | 'updated_at'>,
  now: Date = new Date()
): Promise<number> {
  const [id] = await knex('actions').insert({
    userId: row.userId,
    txid: row.txid ?? null,
    reference: row.reference,
    description: row.description,
    isOutgoing: row.isOutgoing,
    satoshis_delta: row.satoshisDelta,
    version: row.version ?? null,
    lockTime: row.lockTime ?? null,
    user_nosend: row.userNosend,
    hidden: row.hidden,
    user_aborted: row.userAborted,
    raw_tx_draft: row.rawTxDraft != null ? Buffer.from(row.rawTxDraft) : null,
    input_beef_draft: row.inputBeefDraft != null ? Buffer.from(row.inputBeefDraft) : null,
    notify_json: row.notifyJson ?? null,
    row_version: row.rowVersion,
    created_at: now,
    updated_at: now
  })
  if (typeof id === 'number' && id > 0) return id
  const r = await knex('actions').where({ userId: row.userId, reference: row.reference }).first('actionId')
  return r.actionId
}

/** Get the singleton chain tip row (`id = 1`). */
export async function getChainTip (knex: Knex): Promise<TableChainTip | undefined> {
  const row = await knex('chain_tip').where({ id: 1 }).first()
  return row != null ? mapChainTipRow(row) : undefined
}

/** Upsert the singleton chain tip. Always uses `id = 1`. */
export async function setChainTip (
  knex: Knex,
  args: { height: number, blockHash: string, merkleRoot?: string },
  now: Date = new Date()
): Promise<void> {
  const existing = await knex('chain_tip').where({ id: 1 }).first('id')
  if (existing == null) {
    await knex('chain_tip').insert({
      id: 1,
      height: args.height,
      block_hash: args.blockHash,
      merkle_root: args.merkleRoot ?? null,
      observed_at: now,
      created_at: now,
      updated_at: now
    })
    return
  }
  await knex('chain_tip').where({ id: 1 }).update({
    height: args.height,
    block_hash: args.blockHash,
    merkle_root: args.merkleRoot ?? null,
    observed_at: now,
    updated_at: now
  })
}

export function mapTransactionRow (row: any): TableTransactionNew {
  return {
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
    txid: row.txid,
    processing: row.processing,
    processingChangedAt: new Date(row.processing_changed_at),
    nextActionAt: row.next_action_at != null ? new Date(row.next_action_at) : undefined,
    attempts: row.attempts,
    rebroadcastCycles: row.rebroadcast_cycles,
    wasBroadcast: !!row.was_broadcast,
    idempotencyKey: row.idempotency_key ?? undefined,
    batch: row.batch ?? undefined,
    rawTx: row.raw_tx != null ? Array.from((row.raw_tx as Buffer).values()) : undefined,
    inputBeef: row.input_beef != null ? Array.from((row.input_beef as Buffer).values()) : undefined,
    height: row.height ?? undefined,
    merkleIndex: row.merkle_index ?? undefined,
    merklePath: row.merkle_path != null ? Array.from((row.merkle_path as Buffer).values()) : undefined,
    merkleRoot: row.merkle_root ?? undefined,
    blockHash: row.block_hash ?? undefined,
    isCoinbase: !!row.is_coinbase,
    lastProvider: row.last_provider ?? undefined,
    lastProviderStatus: row.last_provider_status ?? undefined,
    frozenReason: row.frozen_reason ?? undefined,
    rowVersion: row.row_version
  }
}

function unmapTransactionRow (
  row: Omit<TableTransactionNew, 'created_at' | 'updated_at'>,
  now: Date
): any {
  return {
    txid: row.txid,
    processing: row.processing,
    processing_changed_at: row.processingChangedAt,
    next_action_at: row.nextActionAt ?? null,
    attempts: row.attempts,
    rebroadcast_cycles: row.rebroadcastCycles,
    was_broadcast: row.wasBroadcast,
    idempotency_key: row.idempotencyKey ?? null,
    batch: row.batch ?? null,
    raw_tx: row.rawTx != null ? Buffer.from(row.rawTx) : null,
    input_beef: row.inputBeef != null ? Buffer.from(row.inputBeef) : null,
    height: row.height ?? null,
    merkle_index: row.merkleIndex ?? null,
    merkle_path: row.merklePath != null ? Buffer.from(row.merklePath) : null,
    merkle_root: row.merkleRoot ?? null,
    block_hash: row.blockHash ?? null,
    is_coinbase: row.isCoinbase,
    last_provider: row.lastProvider ?? null,
    last_provider_status: row.lastProviderStatus ?? null,
    frozen_reason: row.frozenReason ?? null,
    row_version: row.rowVersion,
    created_at: now,
    updated_at: now
  }
}

export function mapActionRow (row: any): TableAction {
  return {
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
    actionId: row.actionId,
    userId: row.userId,
    txid: row.txid ?? undefined,
    reference: row.reference,
    description: row.description,
    isOutgoing: !!row.isOutgoing,
    satoshisDelta: row.satoshis_delta,
    version: row.version ?? undefined,
    lockTime: row.lockTime ?? undefined,
    userNosend: !!row.user_nosend,
    hidden: !!row.hidden,
    userAborted: !!row.user_aborted,
    rawTxDraft: row.raw_tx_draft != null ? Array.from((row.raw_tx_draft as Buffer).values()) : undefined,
    inputBeefDraft: row.input_beef_draft != null ? Array.from((row.input_beef_draft as Buffer).values()) : undefined,
    notifyJson: row.notify_json ?? undefined,
    rowVersion: row.row_version
  }
}

function mapChainTipRow (row: any): TableChainTip {
  return {
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
    id: row.id,
    height: row.height,
    blockHash: row.block_hash,
    merkleRoot: row.merkle_root ?? undefined,
    observedAt: new Date(row.observed_at)
  }
}
