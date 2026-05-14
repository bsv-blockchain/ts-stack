/**
 * Shared helpers for StorageIdb filter methods.
 *
 * These are pure utility functions extracted to reduce cognitive complexity
 * in the large `filter*` methods while keeping their semantics unchanged.
 */

import { IDBPDatabase } from 'idb'
import {
  TableAction,
  TableCertificate,
  TableCertificateField,
  TableCommission,
  TableMonitorEvent,
  TableOutput,
  TableOutputBasket,
  TableOutputTag,
  TableOutputTagMap,
  TableSyncState,
  TableTransactionNew,
  TableTxAudit,
  TableTxLabel,
  TableTxLabelMap
} from './schema/tables'
import { StorageIdbSchema } from './schema/StorageIdbSchema'

// ─── Date comparison helper ───────────────────────────────────────────────────

export function dateMatches (a: Date | undefined, b: Date | undefined): boolean {
  if (a === undefined) return true
  if (b === undefined) return false
  return a.getTime() === b.getTime()
}

// ─── Field comparison helpers (CC-free building blocks) ──────────────────────

/** True when the partial field is absent or equals the record value (undefined-guarded). */
function eq<T> (pv: T | undefined, rv: T): boolean {
  return pv === undefined || pv === rv
}

/** True when the partial field is null/undefined or equals the record value (null-guarded). */
function eqNullable<T> (pv: T | null | undefined, rv: T): boolean {
  return pv == null || pv === rv
}

/** True when the partial Date is absent or the timestamps match (delegates to dateMatches). */
function dateEq (pv: Date | undefined, rv: Date | undefined): boolean {
  return dateMatches(pv, rv)
}

/** True when the partial Date is null/undefined or the timestamps match. */
function dateEqNullable (pv: Date | undefined | null, rv: Date): boolean {
  return pv == null || pv.getTime() === rv.getTime()
}

// ─── Per-entity partial matchers ─────────────────────────────────────────────

export function matchesOutputTagMapPartial (r: TableOutputTagMap, partial: Partial<TableOutputTagMap>): boolean {
  return (
    eq(partial.outputTagId, r.outputTagId) &&
    eq(partial.outputId, r.outputId) &&
    dateEq(partial.created_at, r.created_at) &&
    dateEq(partial.updated_at, r.updated_at) &&
    eq(partial.isDeleted, r.isDeleted)
  )
}

/**
 * v3: `tx_labels_map` keys on `actionId`, not `transactionId`. The interface
 * still exposes a back-compat `transactionId` field that carries the
 * `actionId` value — the matcher reads that field.
 */
export function matchesTxLabelMapPartial (r: TableTxLabelMap, partial: Partial<TableTxLabelMap>): boolean {
  return (
    eq(partial.txLabelId, r.txLabelId) &&
    eq(partial.transactionId, r.transactionId) &&
    dateEq(partial.created_at, r.created_at) &&
    dateEq(partial.updated_at, r.updated_at) &&
    eq(partial.isDeleted, r.isDeleted)
  )
}

export function matchesCertificateFieldPartial (r: TableCertificateField, partial: Partial<TableCertificateField>): boolean {
  return (
    eq(partial.userId, r.userId) &&
    eq(partial.certificateId, r.certificateId) &&
    dateEq(partial.created_at, r.created_at) &&
    dateEq(partial.updated_at, r.updated_at) &&
    eq(partial.fieldName, r.fieldName) &&
    eq(partial.fieldValue, r.fieldValue) &&
    eq(partial.masterKey, r.masterKey)
  )
}

export function matchesCertificatePartial (r: TableCertificate, partial: Partial<TableCertificate>): boolean {
  return (
    eq(partial.userId, r.userId) &&
    eq(partial.certificateId, r.certificateId) &&
    dateEq(partial.created_at, r.created_at) &&
    dateEq(partial.updated_at, r.updated_at) &&
    eq(partial.type, r.type) &&
    eq(partial.serialNumber, r.serialNumber) &&
    eq(partial.certifier, r.certifier) &&
    eq(partial.subject, r.subject) &&
    eq(partial.verifier, r.verifier) &&
    eq(partial.revocationOutpoint, r.revocationOutpoint) &&
    eq(partial.signature, r.signature) &&
    eq(partial.isDeleted, r.isDeleted)
  )
}

/**
 * v3: `commissions.actionId` FKs `actions.actionId`. The interface keeps the
 * back-compat `transactionId` field carrying the same value.
 */
export function matchesCommissionPartial (r: TableCommission, partial: Partial<TableCommission>): boolean {
  return (
    eq(partial.commissionId, r.commissionId) &&
    eq(partial.transactionId, r.transactionId) &&
    eq(partial.userId, r.userId) &&
    dateEq(partial.created_at, r.created_at) &&
    dateEq(partial.updated_at, r.updated_at) &&
    eq(partial.satoshis, r.satoshis) &&
    eq(partial.keyOffset, r.keyOffset) &&
    eq(partial.isRedeemed, r.isRedeemed)
  )
}

export function matchesMonitorEventPartial (r: TableMonitorEvent, partial: Partial<TableMonitorEvent>): boolean {
  return (
    eq(partial.id, r.id) &&
    dateEq(partial.created_at, r.created_at) &&
    dateEq(partial.updated_at, r.updated_at) &&
    eq(partial.event, r.event) &&
    eq(partial.details, r.details)
  )
}

export function matchesOutputBasketPartial (r: TableOutputBasket, partial: Partial<TableOutputBasket>): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const minimumOk = partial.minimumDesiredUTXOValue === undefined || (r as any).numberOfDesiredSatoshis === partial.minimumDesiredUTXOValue
  return (
    eq(partial.basketId, r.basketId) &&
    eq(partial.userId, r.userId) &&
    dateEq(partial.created_at, r.created_at) &&
    dateEq(partial.updated_at, r.updated_at) &&
    eq(partial.name, r.name) &&
    eq(partial.numberOfDesiredUTXOs, r.numberOfDesiredUTXOs) &&
    minimumOk &&
    eq(partial.isDeleted, r.isDeleted)
  )
}

export function matchesOutputPartial (r: TableOutput, partial: Partial<TableOutput>): boolean {
  return (
    matchesOutputPartialIds(r, partial) &&
    matchesOutputPartialDates(r, partial) &&
    matchesOutputPartialScalars(r, partial) &&
    matchesOutputPartialStrings(r, partial)
  )
}

function matchesOutputPartialIds (r: TableOutput, partial: Partial<TableOutput>): boolean {
  return (
    eqNullable(partial.outputId, r.outputId) &&
    eqNullable(partial.userId, r.userId) &&
    eqNullable(partial.transactionId, r.transactionId) &&
    eqNullable(partial.basketId, r.basketId)
  )
}

function matchesOutputPartialDates (r: TableOutput, partial: Partial<TableOutput>): boolean {
  return (
    dateEqNullable(partial.created_at, r.created_at) &&
    dateEqNullable(partial.updated_at, r.updated_at)
  )
}

function matchesOutputPartialScalars (r: TableOutput, partial: Partial<TableOutput>): boolean {
  return (
    eq(partial.spendable, r.spendable) &&
    eq(partial.change, r.change) &&
    eq(partial.vout, r.vout) &&
    eq(partial.satoshis, r.satoshis) &&
    eq(partial.sequenceNumber, r.sequenceNumber) &&
    eq(partial.scriptLength, r.scriptLength) &&
    eq(partial.scriptOffset, r.scriptOffset)
  )
}

function matchesOutputPartialStrings (r: TableOutput, partial: Partial<TableOutput>): boolean {
  return (
    eqNullable(partial.outputDescription, r.outputDescription) &&
    eqNullable(partial.providedBy, r.providedBy) &&
    eqNullable(partial.purpose, r.purpose) &&
    eqNullable(partial.type, r.type) &&
    eqNullable(partial.txid, r.txid) &&
    eqNullable(partial.senderIdentityKey, r.senderIdentityKey) &&
    eqNullable(partial.derivationPrefix, r.derivationPrefix) &&
    eqNullable(partial.derivationSuffix, r.derivationSuffix) &&
    eqNullable(partial.customInstructions, r.customInstructions) &&
    eqNullable(partial.spentBy, r.spentBy)
  )
}

export function matchesOutputTagPartial (r: TableOutputTag, partial: Partial<TableOutputTag>): boolean {
  return (
    eqNullable(partial.outputTagId, r.outputTagId) &&
    eqNullable(partial.userId, r.userId) &&
    dateEqNullable(partial.created_at, r.created_at) &&
    dateEqNullable(partial.updated_at, r.updated_at) &&
    eqNullable(partial.tag, r.tag) &&
    eq(partial.isDeleted, r.isDeleted)
  )
}

export function matchesSyncStatePartial (r: TableSyncState, partial: Partial<TableSyncState>): boolean {
  return (
    matchesSyncStatePartialIds(r, partial) &&
    matchesSyncStatePartialScalars(r, partial) &&
    matchesSyncStatePartialStrings(r, partial)
  )
}

function matchesSyncStatePartialIds (r: TableSyncState, partial: Partial<TableSyncState>): boolean {
  return (
    eqNullable(partial.syncStateId, r.syncStateId) &&
    eqNullable(partial.userId, r.userId) &&
    dateEqNullable(partial.created_at, r.created_at) &&
    dateEqNullable(partial.updated_at, r.updated_at)
  )
}

function matchesSyncStatePartialScalars (r: TableSyncState, partial: Partial<TableSyncState>): boolean {
  return (
    eq(partial.init, r.init) &&
    eq(partial.refNum, r.refNum) &&
    eq(partial.satoshis, r.satoshis) &&
    (partial.when == null || r.when?.getTime() === partial.when.getTime())
  )
}

function matchesSyncStatePartialStrings (r: TableSyncState, partial: Partial<TableSyncState>): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const errorLocalOk = partial.errorLocal == null || (r as any).errorLocale === partial.errorLocal
  return (
    eqNullable(partial.storageIdentityKey, r.storageIdentityKey) &&
    eqNullable(partial.storageName, r.storageName) &&
    eqNullable(partial.status, r.status) &&
    errorLocalOk &&
    eqNullable(partial.errorOther, r.errorOther)
  )
}

/**
 * v3: per-user transaction intent lives in `actions`. The interface name is
 * `TableAction` and uses `actionId`/`txid` directly.
 */
export function matchesActionPartial (r: TableAction, partial: Partial<TableAction>): boolean {
  return (
    eq(partial.actionId, r.actionId) &&
    eq(partial.userId, r.userId) &&
    dateEq(partial.created_at, r.created_at) &&
    dateEq(partial.updated_at, r.updated_at) &&
    eqNullable(partial.txid, r.txid) &&
    eq(partial.reference, r.reference) &&
    eq(partial.description, r.description) &&
    eq(partial.isOutgoing, r.isOutgoing) &&
    eq(partial.satoshisDelta, r.satoshisDelta) &&
    eq(partial.version, r.version) &&
    eq(partial.lockTime, r.lockTime) &&
    eq(partial.userNosend, r.userNosend) &&
    eq(partial.hidden, r.hidden) &&
    eq(partial.userAborted, r.userAborted) &&
    eq(partial.rowVersion, r.rowVersion)
  )
}

/**
 * v3 canonical `transactions` (PK txid). Used only by the v3-aware reads;
 * legacy `findTransactions` returns empty so its matcher is unused.
 */
export function matchesTransactionNewPartial (r: TableTransactionNew, partial: Partial<TableTransactionNew>): boolean {
  return (
    eqNullable(partial.txid, r.txid) &&
    dateEqNullable(partial.created_at, r.created_at) &&
    dateEqNullable(partial.updated_at, r.updated_at) &&
    eq(partial.processing, r.processing) &&
    eq(partial.batch, r.batch) &&
    eq(partial.idempotencyKey, r.idempotencyKey)
  )
}

export function matchesTxAuditPartial (r: TableTxAudit, partial: Partial<TableTxAudit>): boolean {
  return (
    eq(partial.auditId, r.auditId) &&
    eqNullable(partial.txid, r.txid) &&
    eqNullable(partial.actionId, r.actionId) &&
    eq(partial.event, r.event) &&
    dateEq(partial.created_at, r.created_at) &&
    dateEq(partial.updated_at, r.updated_at)
  )
}

export function matchesTxLabelPartial (r: TableTxLabel, partial: Partial<TableTxLabel>): boolean {
  return (
    eqNullable(partial.txLabelId, r.txLabelId) &&
    eqNullable(partial.userId, r.userId) &&
    dateEqNullable(partial.created_at, r.created_at) &&
    dateEqNullable(partial.updated_at, r.updated_at) &&
    eqNullable(partial.label, r.label) &&
    eq(partial.isDeleted, r.isDeleted)
  )
}

// ─── IDB schema upgrade helpers ──────────────────────────────────────────────
//
// v3 layout: no `proven_txs` / `proven_tx_reqs` / `transactions_legacy` stores.
// `transactions` is keyed by `txid` (canonical chain record).
// `actions` carries per-user metadata and FKs `txid` NULL until signed.
// `outputs` FK `actionId`, denormalised `txid`, spent via `spentByActionId`.
// `tx_audit`, `chain_tip`, `monitor_lease` are part of the v3 schema.

export function upgradeUsers (db: IDBPDatabase<StorageIdbSchema>): void {
  const store = db.createObjectStore('users', { keyPath: 'userId', autoIncrement: true })
  store.createIndex('identityKey', 'identityKey', { unique: true })
}

export function upgradeCertificates (db: IDBPDatabase<StorageIdbSchema>): void {
  const store = db.createObjectStore('certificates', { keyPath: 'certificateId', autoIncrement: true })
  store.createIndex('userId', 'userId')
  store.createIndex('userId_type_certifier_serialNumber', ['userId', 'type', 'certifier', 'serialNumber'], { unique: true })
}

export function upgradeCertificateFields (db: IDBPDatabase<StorageIdbSchema>): void {
  const store = db.createObjectStore('certificate_fields', { keyPath: ['certificateId', 'fieldName'] })
  store.createIndex('userId', 'userId')
  store.createIndex('certificateId', 'certificateId')
}

export function upgradeOutputBaskets (db: IDBPDatabase<StorageIdbSchema>): void {
  const store = db.createObjectStore('output_baskets', { keyPath: 'basketId', autoIncrement: true })
  store.createIndex('userId', 'userId')
  store.createIndex('name_userId', ['name', 'userId'], { unique: true })
}

/**
 * v3 canonical `transactions` store — primary key is `txid` (string).
 * There is no integer `transactionId` column.
 */
export function upgradeTransactions (db: IDBPDatabase<StorageIdbSchema>): void {
  const store = db.createObjectStore('transactions', { keyPath: 'txid' })
  store.createIndex('processing', 'processing')
  store.createIndex('batch', 'batch')
  store.createIndex('idempotencyKey', 'idempotencyKey', { unique: true })
}

/**
 * v3 per-user `actions` store. PK `actionId`. `txid` is NULL until signing
 * completes; the `(userId, txid)` and `(userId, reference)` pairs are unique.
 */
export function upgradeActions (db: IDBPDatabase<StorageIdbSchema>): void {
  const store = db.createObjectStore('actions', { keyPath: 'actionId', autoIncrement: true })
  store.createIndex('userId', 'userId')
  store.createIndex('userId_txid', ['userId', 'txid'], { unique: true })
  store.createIndex('userId_reference', ['userId', 'reference'], { unique: true })
  store.createIndex('userId_hidden', ['userId', 'hidden'])
  store.createIndex('txid', 'txid')
}

/**
 * v3 `commissions` store. FKs `actionId` (not `transactionId`).
 * Unique on `actionId`.
 */
export function upgradeCommissions (db: IDBPDatabase<StorageIdbSchema>): void {
  const store = db.createObjectStore('commissions', { keyPath: 'commissionId', autoIncrement: true })
  store.createIndex('userId', 'userId')
  store.createIndex('actionId', 'actionId', { unique: true })
}

/**
 * v3 `outputs` store. FKs `actionId`, denormalised `txid`, spent via
 * `spentByActionId`. Unique on `(actionId, vout)`.
 */
export function upgradeOutputs (db: IDBPDatabase<StorageIdbSchema>): void {
  const store = db.createObjectStore('outputs', { keyPath: 'outputId', autoIncrement: true })
  store.createIndex('actionId_vout', ['actionId', 'vout'], { unique: true })
  store.createIndex('userId_basketId_spendable_satoshis', ['userId', 'basketId', 'spendable', 'satoshis'])
  store.createIndex('userId_spendable_outputId', ['userId', 'spendable', 'outputId'])
  store.createIndex('userId_txid', ['userId', 'txid'])
  store.createIndex('spentByActionId', 'spentByActionId')
  store.createIndex('matures_at_height', 'matures_at_height')
}

export function upgradeOutputTags (db: IDBPDatabase<StorageIdbSchema>): void {
  const store = db.createObjectStore('output_tags', { keyPath: 'outputTagId', autoIncrement: true })
  store.createIndex('userId', 'userId')
  store.createIndex('tag_userId', ['tag', 'userId'], { unique: true })
}

export function upgradeOutputTagsMap (db: IDBPDatabase<StorageIdbSchema>): void {
  const store = db.createObjectStore('output_tags_map', { keyPath: ['outputTagId', 'outputId'] })
  store.createIndex('outputTagId', 'outputTagId')
  store.createIndex('outputId', 'outputId')
}

export function upgradeTxLabels (db: IDBPDatabase<StorageIdbSchema>): void {
  const store = db.createObjectStore('tx_labels', { keyPath: 'txLabelId', autoIncrement: true })
  store.createIndex('userId', 'userId')
  store.createIndex('label_userId', ['label', 'userId'], { unique: true })
}

/**
 * v3 `tx_labels_map` — composite key on `(txLabelId, actionId)`.
 */
export function upgradeTxLabelsMap (db: IDBPDatabase<StorageIdbSchema>): void {
  const store = db.createObjectStore('tx_labels_map', { keyPath: ['txLabelId', 'actionId'] })
  store.createIndex('txLabelId', 'txLabelId')
  store.createIndex('actionId', 'actionId')
}

export function upgradeMonitorEvents (db: IDBPDatabase<StorageIdbSchema>): void {
  db.createObjectStore('monitor_events', { keyPath: 'id', autoIncrement: true })
}

export function upgradeSyncStates (db: IDBPDatabase<StorageIdbSchema>): void {
  const store = db.createObjectStore('sync_states', { keyPath: 'syncStateId', autoIncrement: true })
  store.createIndex('userId', 'userId')
  store.createIndex('refNum', 'refNum', { unique: true })
  store.createIndex('status', 'status')
}

export function upgradeChainTip (db: IDBPDatabase<StorageIdbSchema>): void {
  db.createObjectStore('chain_tip', { keyPath: 'id' })
}

/**
 * v3 `tx_audit` — appends event records keyed by `auditId` PK.
 * Each row scopes to a `txid`, an `actionId`, or both.
 */
export function upgradeTxAudit (db: IDBPDatabase<StorageIdbSchema>): void {
  const store = db.createObjectStore('tx_audit', { keyPath: 'auditId', autoIncrement: true })
  store.createIndex('txid', 'txid')
  store.createIndex('actionId', 'actionId')
  store.createIndex('event', 'event')
}

export function upgradeMonitorLease (db: IDBPDatabase<StorageIdbSchema>): void {
  const store = db.createObjectStore('monitor_lease', { keyPath: 'taskName' })
  store.createIndex('expiresAt', 'expiresAt')
}

// ─── Bulk store initialisation (called by the v3 upgrade) ────────────────────

/**
 * v3 store layout. Creates the full set of v3 IDB object stores on first
 * open. Re-running this on a database that already has v2 stores is a no-op
 * (each helper guards with `contains`).
 *
 * Legacy stores `proven_txs`, `proven_tx_reqs`, `transactions_new` are
 * dropped by the `onupgradeneeded` step in `StorageIdb.initDB`.
 */
export function upgradeAllStoresV3 (db: IDBPDatabase<StorageIdbSchema>): void {
  const names = db.objectStoreNames
  if (!names.contains('users')) upgradeUsers(db)
  if (!names.contains('certificates')) upgradeCertificates(db)
  if (!names.contains('certificate_fields')) upgradeCertificateFields(db)
  if (!names.contains('output_baskets')) upgradeOutputBaskets(db)
  if (!names.contains('transactions')) upgradeTransactions(db)
  if (!names.contains('actions')) upgradeActions(db)
  if (!names.contains('commissions')) upgradeCommissions(db)
  if (!names.contains('outputs')) upgradeOutputs(db)
  if (!names.contains('output_tags')) upgradeOutputTags(db)
  if (!names.contains('output_tags_map')) upgradeOutputTagsMap(db)
  if (!names.contains('tx_labels')) upgradeTxLabels(db)
  if (!names.contains('tx_labels_map')) upgradeTxLabelsMap(db)
  if (!names.contains('monitor_events')) upgradeMonitorEvents(db)
  if (!names.contains('sync_states')) upgradeSyncStates(db)
  if (!names.contains('chain_tip')) upgradeChainTip(db)
  if (!names.contains('tx_audit')) upgradeTxAudit(db)
  if (!names.contains('monitor_lease')) upgradeMonitorLease(db)
}

/**
 * Drop legacy v1/v2 object stores that no longer exist in v3.
 * Safe to call when the DB is being upgraded from any prior version.
 */
export function dropLegacyStores (db: IDBPDatabase<StorageIdbSchema>): void {
  const names = db.objectStoreNames
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const drop = (n: string): void => { if (names.contains(n as any)) (db as any).deleteObjectStore(n) }
  drop('proven_txs')
  drop('proven_tx_reqs')
  drop('transactions_new')
}
