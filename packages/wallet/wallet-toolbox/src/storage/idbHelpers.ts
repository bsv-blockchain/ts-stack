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

// ─── Per-entity partial matchers ─────────────────────────────────────────────

export function matchesOutputTagMapPartial (r: TableOutputTagMap, partial: Partial<TableOutputTagMap>): boolean {
  if (partial.outputTagId !== undefined && r.outputTagId !== partial.outputTagId) return false
  if (partial.outputId !== undefined && r.outputId !== partial.outputId) return false
  if (partial.created_at !== undefined && !dateMatches(partial.created_at, r.created_at)) return false
  if (partial.updated_at !== undefined && !dateMatches(partial.updated_at, r.updated_at)) return false
  if (partial.isDeleted !== undefined && r.isDeleted !== partial.isDeleted) return false
  return true
}

export function matchesProvenTxReqPartial (r: TableProvenTxReq, partial: Partial<TableProvenTxReq>): boolean {
  if (partial.provenTxReqId !== undefined && r.provenTxReqId !== partial.provenTxReqId) return false
  if (partial.provenTxId !== undefined && r.provenTxId !== partial.provenTxId) return false
  if (partial.created_at !== undefined && !dateMatches(partial.created_at, r.created_at)) return false
  if (partial.updated_at !== undefined && !dateMatches(partial.updated_at, r.updated_at)) return false
  if (partial.status !== undefined && r.status !== partial.status) return false
  if (partial.attempts !== undefined && r.attempts !== partial.attempts) return false
  if (partial.notified !== undefined && r.notified !== partial.notified) return false
  if (partial.txid !== undefined && r.txid !== partial.txid) return false
  if (partial.batch !== undefined && r.batch !== partial.batch) return false
  if (partial.history !== undefined && r.history !== partial.history) return false
  if (partial.notify !== undefined && r.notify !== partial.notify) return false
  return true
}

export function matchesProvenTxPartial (r: TableProvenTx, partial: Partial<TableProvenTx>): boolean {
  if (partial.provenTxId !== undefined && r.provenTxId !== partial.provenTxId) return false
  if (partial.created_at !== undefined && !dateMatches(partial.created_at, r.created_at)) return false
  if (partial.updated_at !== undefined && !dateMatches(partial.updated_at, r.updated_at)) return false
  if (partial.txid !== undefined && r.txid !== partial.txid) return false
  if (partial.height !== undefined && r.height !== partial.height) return false
  if (partial.index !== undefined && r.index !== partial.index) return false
  if (partial.blockHash !== undefined && r.blockHash !== partial.blockHash) return false
  if (partial.merkleRoot !== undefined && r.merkleRoot !== partial.merkleRoot) return false
  return true
}

export function matchesTxLabelMapPartial (r: TableTxLabelMap, partial: Partial<TableTxLabelMap>): boolean {
  if (partial.txLabelId !== undefined && r.txLabelId !== partial.txLabelId) return false
  if (partial.transactionId !== undefined && r.transactionId !== partial.transactionId) return false
  if (partial.created_at !== undefined && !dateMatches(partial.created_at, r.created_at)) return false
  if (partial.updated_at !== undefined && !dateMatches(partial.updated_at, r.updated_at)) return false
  if (partial.isDeleted !== undefined && r.isDeleted !== partial.isDeleted) return false
  return true
}

export function matchesCertificateFieldPartial (r: TableCertificateField, partial: Partial<TableCertificateField>): boolean {
  if (partial.userId !== undefined && r.userId !== partial.userId) return false
  if (partial.certificateId !== undefined && r.certificateId !== partial.certificateId) return false
  if (partial.created_at !== undefined && !dateMatches(partial.created_at, r.created_at)) return false
  if (partial.updated_at !== undefined && !dateMatches(partial.updated_at, r.updated_at)) return false
  if (partial.fieldName !== undefined && r.fieldName !== partial.fieldName) return false
  if (partial.fieldValue !== undefined && r.fieldValue !== partial.fieldValue) return false
  if (partial.masterKey !== undefined && r.masterKey !== partial.masterKey) return false
  return true
}

export function matchesCertificatePartial (r: TableCertificate, partial: Partial<TableCertificate>): boolean {
  if (partial.userId !== undefined && r.userId !== partial.userId) return false
  if (partial.certificateId !== undefined && r.certificateId !== partial.certificateId) return false
  if (partial.created_at !== undefined && !dateMatches(partial.created_at, r.created_at)) return false
  if (partial.updated_at !== undefined && !dateMatches(partial.updated_at, r.updated_at)) return false
  if (partial.type !== undefined && r.type !== partial.type) return false
  if (partial.serialNumber !== undefined && r.serialNumber !== partial.serialNumber) return false
  if (partial.certifier !== undefined && r.certifier !== partial.certifier) return false
  if (partial.subject !== undefined && r.subject !== partial.subject) return false
  if (partial.verifier !== undefined && r.verifier !== partial.verifier) return false
  if (partial.revocationOutpoint !== undefined && r.revocationOutpoint !== partial.revocationOutpoint) return false
  if (partial.signature !== undefined && r.signature !== partial.signature) return false
  if (partial.isDeleted !== undefined && r.isDeleted !== partial.isDeleted) return false
  return true
}

export function matchesCommissionPartial (r: TableCommission, partial: Partial<TableCommission>): boolean {
  if (partial.commissionId !== undefined && r.commissionId !== partial.commissionId) return false
  if (partial.transactionId !== undefined && r.transactionId !== partial.transactionId) return false
  if (partial.userId !== undefined && r.userId !== partial.userId) return false
  if (partial.created_at !== undefined && !dateMatches(partial.created_at, r.created_at)) return false
  if (partial.updated_at !== undefined && !dateMatches(partial.updated_at, r.updated_at)) return false
  if (partial.satoshis !== undefined && r.satoshis !== partial.satoshis) return false
  if (partial.keyOffset !== undefined && r.keyOffset !== partial.keyOffset) return false
  if (partial.isRedeemed !== undefined && r.isRedeemed !== partial.isRedeemed) return false
  return true
}

export function matchesMonitorEventPartial (r: TableMonitorEvent, partial: Partial<TableMonitorEvent>): boolean {
  if (partial.id !== undefined && r.id !== partial.id) return false
  if (partial.created_at !== undefined && !dateMatches(partial.created_at, r.created_at)) return false
  if (partial.updated_at !== undefined && !dateMatches(partial.updated_at, r.updated_at)) return false
  if (partial.event !== undefined && r.event !== partial.event) return false
  if (partial.details !== undefined && r.details !== partial.details) return false
  return true
}

export function matchesOutputBasketPartial (r: TableOutputBasket, partial: Partial<TableOutputBasket>): boolean {
  if (partial.basketId !== undefined && r.basketId !== partial.basketId) return false
  if (partial.userId !== undefined && r.userId !== partial.userId) return false
  if (partial.created_at !== undefined && !dateMatches(partial.created_at, r.created_at)) return false
  if (partial.updated_at !== undefined && !dateMatches(partial.updated_at, r.updated_at)) return false
  if (partial.name !== undefined && r.name !== partial.name) return false
  if (partial.numberOfDesiredUTXOs !== undefined && r.numberOfDesiredUTXOs !== partial.numberOfDesiredUTXOs) return false
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (partial.minimumDesiredUTXOValue !== undefined && (r as any).numberOfDesiredSatoshis !== partial.minimumDesiredUTXOValue) return false
  if (partial.isDeleted !== undefined && r.isDeleted !== partial.isDeleted) return false
  return true
}

export function matchesOutputPartial (r: TableOutput, partial: Partial<TableOutput>): boolean {
  if (partial.outputId && r.outputId !== partial.outputId) return false
  if (partial.userId && r.userId !== partial.userId) return false
  if (partial.transactionId && r.transactionId !== partial.transactionId) return false
  if (partial.basketId && r.basketId !== partial.basketId) return false
  if (partial.created_at != null && r.created_at.getTime() !== partial.created_at.getTime()) return false
  if (partial.updated_at != null && r.updated_at.getTime() !== partial.updated_at.getTime()) return false
  if (partial.spendable !== undefined && r.spendable !== partial.spendable) return false
  if (partial.change !== undefined && r.change !== partial.change) return false
  if (partial.outputDescription && r.outputDescription !== partial.outputDescription) return false
  if (partial.vout !== undefined && r.vout !== partial.vout) return false
  if (partial.satoshis !== undefined && r.satoshis !== partial.satoshis) return false
  if (partial.providedBy && r.providedBy !== partial.providedBy) return false
  if (partial.purpose && r.purpose !== partial.purpose) return false
  if (partial.type && r.type !== partial.type) return false
  if (partial.txid && r.txid !== partial.txid) return false
  if (partial.senderIdentityKey && r.senderIdentityKey !== partial.senderIdentityKey) return false
  if (partial.derivationPrefix && r.derivationPrefix !== partial.derivationPrefix) return false
  if (partial.derivationSuffix && r.derivationSuffix !== partial.derivationSuffix) return false
  if (partial.customInstructions && r.customInstructions !== partial.customInstructions) return false
  if (partial.spentBy && r.spentBy !== partial.spentBy) return false
  if (partial.sequenceNumber !== undefined && r.sequenceNumber !== partial.sequenceNumber) return false
  if (partial.scriptLength !== undefined && r.scriptLength !== partial.scriptLength) return false
  if (partial.scriptOffset !== undefined && r.scriptOffset !== partial.scriptOffset) return false
  return true
}

export function matchesOutputTagPartial (r: TableOutputTag, partial: Partial<TableOutputTag>): boolean {
  if (partial.outputTagId && r.outputTagId !== partial.outputTagId) return false
  if (partial.userId && r.userId !== partial.userId) return false
  if (partial.created_at != null && r.created_at.getTime() !== partial.created_at.getTime()) return false
  if (partial.updated_at != null && r.updated_at.getTime() !== partial.updated_at.getTime()) return false
  if (partial.tag && r.tag !== partial.tag) return false
  if (partial.isDeleted !== undefined && r.isDeleted !== partial.isDeleted) return false
  return true
}

export function matchesSyncStatePartial (r: TableSyncState, partial: Partial<TableSyncState>): boolean {
  if (partial.syncStateId && r.syncStateId !== partial.syncStateId) return false
  if (partial.userId && r.userId !== partial.userId) return false
  if (partial.created_at != null && r.created_at.getTime() !== partial.created_at.getTime()) return false
  if (partial.updated_at != null && r.updated_at.getTime() !== partial.updated_at.getTime()) return false
  if (partial.storageIdentityKey && r.storageIdentityKey !== partial.storageIdentityKey) return false
  if (partial.storageName && r.storageName !== partial.storageName) return false
  if (partial.status && r.status !== partial.status) return false
  if (partial.init !== undefined && r.init !== partial.init) return false
  if (partial.refNum !== undefined && r.refNum !== partial.refNum) return false
  if (partial.when != null && r.when?.getTime() !== partial.when.getTime()) return false
  if (partial.satoshis !== undefined && r.satoshis !== partial.satoshis) return false
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (partial.errorLocal && (r as any).errorLocale !== partial.errorLocal) return false
  if (partial.errorOther && r.errorOther !== partial.errorOther) return false
  return true
}

export function matchesTransactionPartial (r: TableTransaction, partial: Partial<TableTransaction>): boolean {
  if (partial.transactionId && r.transactionId !== partial.transactionId) return false
  if (partial.userId && r.userId !== partial.userId) return false
  if (partial.created_at != null && r.created_at.getTime() !== partial.created_at.getTime()) return false
  if (partial.updated_at != null && r.updated_at.getTime() !== partial.updated_at.getTime()) return false
  if (partial.provenTxId && r.provenTxId !== partial.provenTxId) return false
  if (partial.status && r.status !== partial.status) return false
  if (partial.reference && r.reference !== partial.reference) return false
  if (partial.isOutgoing !== undefined && r.isOutgoing !== partial.isOutgoing) return false
  if (partial.satoshis !== undefined && r.satoshis !== partial.satoshis) return false
  if (partial.description && r.description !== partial.description) return false
  if (partial.version !== undefined && r.version !== partial.version) return false
  if (partial.lockTime !== undefined && r.lockTime !== partial.lockTime) return false
  if (partial.txid && r.txid !== partial.txid) return false
  return true
}

export function matchesTxLabelPartial (r: TableTxLabel, partial: Partial<TableTxLabel>): boolean {
  if (partial.txLabelId && r.txLabelId !== partial.txLabelId) return false
  if (partial.userId && r.userId !== partial.userId) return false
  if (partial.created_at != null && r.created_at.getTime() !== partial.created_at.getTime()) return false
  if (partial.updated_at != null && r.updated_at.getTime() !== partial.updated_at.getTime()) return false
  if (partial.label && r.label !== partial.label) return false
  if (partial.isDeleted !== undefined && r.isDeleted !== partial.isDeleted) return false
  return true
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
