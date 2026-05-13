/**
 * Shared helpers for StorageIdb filter methods.
 *
 * These are pure utility functions extracted to reduce cognitive complexity
 * in the large `filter*` methods while keeping their semantics unchanged.
 */

import { IDBPDatabase } from 'idb'
import {
  TableCertificate,
  TableCertificateField,
  TableCommission,
  TableMonitorEvent,
  TableOutput,
  TableOutputBasket,
  TableOutputTag,
  TableOutputTagMap,
  TableProvenTx,
  TableProvenTxReq,
  TableSyncState,
  TableTransaction,
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

export function matchesProvenTxReqPartial (r: TableProvenTxReq, partial: Partial<TableProvenTxReq>): boolean {
  return (
    eq(partial.provenTxReqId, r.provenTxReqId) &&
    eq(partial.provenTxId, r.provenTxId) &&
    dateEq(partial.created_at, r.created_at) &&
    dateEq(partial.updated_at, r.updated_at) &&
    eq(partial.status, r.status) &&
    eq(partial.attempts, r.attempts) &&
    eq(partial.notified, r.notified) &&
    eq(partial.txid, r.txid) &&
    eq(partial.batch, r.batch) &&
    eq(partial.history, r.history) &&
    eq(partial.notify, r.notify)
  )
}

export function matchesProvenTxPartial (r: TableProvenTx, partial: Partial<TableProvenTx>): boolean {
  return (
    eq(partial.provenTxId, r.provenTxId) &&
    dateEq(partial.created_at, r.created_at) &&
    dateEq(partial.updated_at, r.updated_at) &&
    eq(partial.txid, r.txid) &&
    eq(partial.height, r.height) &&
    eq(partial.index, r.index) &&
    eq(partial.blockHash, r.blockHash) &&
    eq(partial.merkleRoot, r.merkleRoot)
  )
}

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

export function matchesTransactionPartial (r: TableTransaction, partial: Partial<TableTransaction>): boolean {
  return (
    matchesTransactionPartialIds(r, partial) &&
    matchesTransactionPartialScalars(r, partial) &&
    matchesTransactionPartialStrings(r, partial)
  )
}

function matchesTransactionPartialIds (r: TableTransaction, partial: Partial<TableTransaction>): boolean {
  return (
    eqNullable(partial.transactionId, r.transactionId) &&
    eqNullable(partial.userId, r.userId) &&
    dateEqNullable(partial.created_at, r.created_at) &&
    dateEqNullable(partial.updated_at, r.updated_at) &&
    eqNullable(partial.provenTxId, r.provenTxId)
  )
}

function matchesTransactionPartialScalars (r: TableTransaction, partial: Partial<TableTransaction>): boolean {
  return (
    eq(partial.isOutgoing, r.isOutgoing) &&
    eq(partial.satoshis, r.satoshis) &&
    eq(partial.version, r.version) &&
    eq(partial.lockTime, r.lockTime)
  )
}

function matchesTransactionPartialStrings (r: TableTransaction, partial: Partial<TableTransaction>): boolean {
  return (
    eqNullable(partial.status, r.status) &&
    eqNullable(partial.reference, r.reference) &&
    eqNullable(partial.description, r.description) &&
    eqNullable(partial.txid, r.txid)
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

export function upgradeProvenTxs (db: IDBPDatabase<StorageIdbSchema>): void {
  const store = db.createObjectStore('proven_txs', { keyPath: 'provenTxId', autoIncrement: true })
  store.createIndex('txid', 'txid', { unique: true })
}

export function upgradeProvenTxReqs (db: IDBPDatabase<StorageIdbSchema>): void {
  const store = db.createObjectStore('proven_tx_reqs', { keyPath: 'provenTxReqId', autoIncrement: true })
  store.createIndex('provenTxId', 'provenTxId')
  store.createIndex('txid', 'txid', { unique: true })
  store.createIndex('status', 'status')
  store.createIndex('batch', 'batch')
}

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

export function upgradeTransactions (db: IDBPDatabase<StorageIdbSchema>): void {
  const store = db.createObjectStore('transactions', { keyPath: 'transactionId', autoIncrement: true })
  store.createIndex('userId', 'userId')
  store.createIndex('status', 'status')
  store.createIndex('status_userId', ['status', 'userId'])
  store.createIndex('provenTxId', 'provenTxId')
  store.createIndex('reference', 'reference', { unique: true })
}

export function upgradeCommissions (db: IDBPDatabase<StorageIdbSchema>): void {
  const store = db.createObjectStore('commissions', { keyPath: 'commissionId', autoIncrement: true })
  store.createIndex('userId', 'userId')
  store.createIndex('transactionId', 'transactionId', { unique: true })
}

export function upgradeOutputs (db: IDBPDatabase<StorageIdbSchema>): void {
  const store = db.createObjectStore('outputs', { keyPath: 'outputId', autoIncrement: true })
  store.createIndex('userId', 'userId')
  store.createIndex('transactionId', 'transactionId')
  store.createIndex('basketId', 'basketId')
  store.createIndex('spentBy', 'spentBy')
  store.createIndex('transactionId_vout_userId', ['transactionId', 'vout', 'userId'], { unique: true })
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

export function upgradeTxLabelsMap (db: IDBPDatabase<StorageIdbSchema>): void {
  const store = db.createObjectStore('tx_labels_map', { keyPath: ['txLabelId', 'transactionId'] })
  store.createIndex('txLabelId', 'txLabelId')
  store.createIndex('transactionId', 'transactionId')
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

export function upgradeTransactionsNew (db: IDBPDatabase<StorageIdbSchema>): void {
  const store = db.createObjectStore('transactions_new', { keyPath: 'transactionId', autoIncrement: true })
  store.createIndex('txid', 'txid', { unique: true })
  store.createIndex('processing', 'processing')
  store.createIndex('batch', 'batch')
  store.createIndex('idempotencyKey', 'idempotencyKey', { unique: true })
}

export function upgradeActions (db: IDBPDatabase<StorageIdbSchema>): void {
  const store = db.createObjectStore('actions', { keyPath: 'actionId', autoIncrement: true })
  store.createIndex('userId', 'userId')
  store.createIndex('transactionId', 'transactionId')
  store.createIndex('userId_transactionId', ['userId', 'transactionId'], { unique: true })
  store.createIndex('userId_reference', ['userId', 'reference'], { unique: true })
}

export function upgradeChainTip (db: IDBPDatabase<StorageIdbSchema>): void {
  db.createObjectStore('chain_tip', { keyPath: 'id' })
}

export function upgradeTxAudit (db: IDBPDatabase<StorageIdbSchema>): void {
  const store = db.createObjectStore('tx_audit', { keyPath: 'auditId', autoIncrement: true })
  store.createIndex('transactionId', 'transactionId')
  store.createIndex('actionId', 'actionId')
  store.createIndex('event', 'event')
}

export function upgradeMonitorLease (db: IDBPDatabase<StorageIdbSchema>): void {
  const store = db.createObjectStore('monitor_lease', { keyPath: 'taskName' })
  store.createIndex('expiresAt', 'expiresAt')
}

// ─── Bulk store initialisation (called by the version-1 upgrade) ─────────────

/** Upgrade handler for every store that existed at schema version 1. */
export function upgradeAllStoresV1 (db: IDBPDatabase<StorageIdbSchema>): void {
  const names = db.objectStoreNames
  if (!names.contains('proven_txs')) upgradeProvenTxs(db)
  if (!names.contains('proven_tx_reqs')) upgradeProvenTxReqs(db)
  if (!names.contains('users')) upgradeUsers(db)
  if (!names.contains('certificates')) upgradeCertificates(db)
  if (!names.contains('certificate_fields')) upgradeCertificateFields(db)
  if (!names.contains('output_baskets')) upgradeOutputBaskets(db)
  if (!names.contains('transactions')) upgradeTransactions(db)
  if (!names.contains('commissions')) upgradeCommissions(db)
  if (!names.contains('outputs')) upgradeOutputs(db)
  if (!names.contains('output_tags')) upgradeOutputTags(db)
  if (!names.contains('output_tags_map')) upgradeOutputTagsMap(db)
  if (!names.contains('tx_labels')) upgradeTxLabels(db)
  if (!names.contains('tx_labels_map')) upgradeTxLabelsMap(db)
  if (!names.contains('monitor_events')) upgradeMonitorEvents(db)
  if (!names.contains('sync_states')) upgradeSyncStates(db)
  if (!names.contains('transactions_new')) upgradeTransactionsNew(db)
  if (!names.contains('actions')) upgradeActions(db)
  if (!names.contains('chain_tip')) upgradeChainTip(db)
  if (!names.contains('tx_audit')) upgradeTxAudit(db)
  if (!names.contains('monitor_lease')) upgradeMonitorLease(db)
}
