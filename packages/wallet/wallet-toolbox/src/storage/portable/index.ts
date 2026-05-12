/* eslint-disable @typescript-eslint/triple-slash-reference */
/// <reference path="../../types/bsv-sdk-aesgcm.d.ts" />
/* eslint-enable @typescript-eslint/triple-slash-reference */

import { Random, Utils } from '@bsv/sdk'
import { AESGCM, AESGCMDecrypt } from '@bsv/sdk/primitives/AESGCM'
import { argon2id } from 'hash-wasm'
import { StorageProvider } from '../StorageProvider'
import {
  TableCertificate,
  TableCertificateField,
  TableCommission,
  TableOutput,
  TableOutputBasket,
  TableOutputTag,
  TableOutputTagMap,
  TableProvenTx,
  TableProvenTxReq,
  TableSettings,
  TableSyncState,
  TableTransaction,
  TableTxLabel,
  TableTxLabelMap,
  TableUser
} from '../schema/tables'
import { createSyncMap, SyncMap } from '../schema/entities/EntityBase'
import * as sdk from '../../sdk'
import { verifyOne, verifyOneOrNone, verifyTruthy } from '../../utility/utilityHelpers'

type JsonPrimitive = string | number | boolean
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
type PortableRow = Record<string, JsonValue>

export interface BRC38Tables {
  provenTxs: PortableRow[]
  provenTxReqs: PortableRow[]
  outputBaskets: PortableRow[]
  transactions: PortableRow[]
  commissions: PortableRow[]
  outputs: PortableRow[]
  outputTags: PortableRow[]
  outputTagMaps: PortableRow[]
  txLabels: PortableRow[]
  txLabelMaps: PortableRow[]
  certificates: PortableRow[]
  certificateFields: PortableRow[]
  syncStates: PortableRow[]
}

export interface BRC38WalletData {
  brc: 38
  title: 'User Wallet Data Format'
  formatVersion: 1
  exportedAt: string
  sourceStorage: PortableRow
  user: PortableRow
  tables: BRC38Tables
}

export interface BRC38ImportOptions {
  mode: 'merge' | 'restore'
}

export interface BRC38ImportResult {
  mode: 'merge' | 'restore'
  identityKey: string
  userId: number
  inserts: number
  updates: number
}

export interface BRC39Options {
  iterations?: number
  memoryKiB?: number
  parallelism?: number
}

interface DecodedBRC38 {
  sourceStorage: TableSettings
  user: TableUser
  provenTxs: TableProvenTx[]
  provenTxReqs: TableProvenTxReq[]
  outputBaskets: TableOutputBasket[]
  transactions: TableTransaction[]
  commissions: TableCommission[]
  outputs: TableOutput[]
  outputTags: TableOutputTag[]
  outputTagMaps: TableOutputTagMap[]
  txLabels: TableTxLabel[]
  txLabelMaps: TableTxLabelMap[]
  certificates: TableCertificate[]
  certificateFields: TableCertificateField[]
  syncStates: TableSyncState[]
}

const BRC38_TITLE = 'User Wallet Data Format'
const BRC39_MAGIC = [0x57, 0x44, 0x41, 0x54] // WDAT
const BRC39_HEADER_LENGTH = 33
const BRC39_TAG_LENGTH = 16
const BRC39_DEFAULT_ITERATIONS = 7
const BRC39_DEFAULT_MEMORY_KIB = 131072
const BRC39_DEFAULT_PARALLELISM = 1
const BRC39_HASH_LENGTH = 32
const BRC39_SALT_LENGTH = 32
const BRC39_NONCE_LENGTH = 32

const tableNames: Array<keyof BRC38Tables> = [
  'provenTxs',
  'provenTxReqs',
  'outputBaskets',
  'transactions',
  'commissions',
  'outputs',
  'outputTags',
  'outputTagMaps',
  'txLabels',
  'txLabelMaps',
  'certificates',
  'certificateFields',
  'syncStates'
]

const SYNC_CHUNK_ENTITY_ORDER = [
  'provenTx',
  'outputBasket',
  'outputTag',
  'txLabel',
  'transaction',
  'output',
  'txLabelMap',
  'outputTagMap',
  'certificate',
  'certificateField',
  'commission',
  'provenTxReq'
]

const binaryFieldsByKind: Partial<Record<string, string[]>> = {
  commission: ['lockingScript'],
  output: ['lockingScript'],
  provenTx: ['merklePath', 'rawTx'],
  provenTxReq: ['rawTx', 'inputBEEF'],
  transaction: ['inputBEEF', 'rawTx']
}

const jsonFieldsByKind: Partial<Record<string, string[]>> = {
  provenTxReq: ['history', 'notify'],
  syncState: ['syncMap', 'errorLocal', 'errorOther']
}

const dateFieldsByKind: Partial<Record<string, string[]>> = {
  settings: ['created_at', 'updated_at'],
  user: ['created_at', 'updated_at'],
  provenTx: ['created_at', 'updated_at'],
  provenTxReq: ['created_at', 'updated_at'],
  outputBasket: ['created_at', 'updated_at'],
  transaction: ['created_at', 'updated_at'],
  commission: ['created_at', 'updated_at'],
  output: ['created_at', 'updated_at'],
  outputTag: ['created_at', 'updated_at'],
  outputTagMap: ['created_at', 'updated_at'],
  txLabel: ['created_at', 'updated_at'],
  txLabelMap: ['created_at', 'updated_at'],
  certificate: ['created_at', 'updated_at'],
  certificateField: ['created_at', 'updated_at'],
  syncState: ['created_at', 'updated_at', 'when']
}

export async function exportBRC38 (storage: StorageProvider, identityKey: string): Promise<BRC38WalletData> {
  const sourceStorage = await storage.makeAvailable()
  const user = verifyTruthy(await storage.findUserByIdentityKey(identityKey))
  const userId = user.userId

  const transactions = await storage.findTransactions({ partial: { userId } })
  const transactionIds = new Set(transactions.map(t => t.transactionId))
  const transactionTxids = new Set(transactions.map(t => t.txid).filter((txid): txid is string => txid != null))

  const provenTxReqs = (await storage.getProvenTxReqsForUser({ userId })).filter(r => transactionTxids.has(r.txid))
  const provenTxIds = new Set<number>()
  for (const tx of transactions) if (tx.provenTxId != null) provenTxIds.add(tx.provenTxId)
  for (const req of provenTxReqs) if (req.provenTxId != null) provenTxIds.add(req.provenTxId)

  const provenTxs: TableProvenTx[] = []
  for (const provenTxId of Array.from(provenTxIds).sort(compareNumber)) {
    const proven = verifyOneOrNone(await storage.findProvenTxs({ partial: { provenTxId } }))
    if (proven != null) provenTxs.push(proven)
  }

  const outputBaskets = await storage.findOutputBaskets({ partial: { userId } })
  const commissions = await storage.findCommissions({ partial: { userId } })
  const outputs = await storage.findOutputs({ partial: { userId } })
  const outputTags = await storage.findOutputTags({ partial: { userId } })
  const outputTagMaps = (await storage.getOutputTagMapsForUser({ userId }))
    .filter(m => outputs.some(o => o.outputId === m.outputId))
  const txLabels = await storage.findTxLabels({ partial: { userId } })
  const txLabelMaps = (await storage.getTxLabelMapsForUser({ userId }))
    .filter(m => transactionIds.has(m.transactionId))
  const certificates = await storage.findCertificates({ partial: { userId } })
  const certificateFields = await storage.findCertificateFields({ partial: { userId } })
  const syncStates = await storage.findSyncStates({ partial: { userId } })

  const data: BRC38WalletData = {
    brc: 38,
    title: BRC38_TITLE,
    formatVersion: 1,
    exportedAt: isoDate(new Date()),
    sourceStorage: portableRow('settings', sourceStorage),
    user: portableRow('user', user),
    tables: {
      provenTxs: provenTxs.map(r => portableRow('provenTx', r)),
      provenTxReqs: provenTxReqs.map(r => portableRow('provenTxReq', r)),
      outputBaskets: outputBaskets.map(r => portableRow('outputBasket', r)),
      transactions: transactions.map(r => portableRow('transaction', r)),
      commissions: commissions.map(r => portableRow('commission', r)),
      outputs: outputs.map(r => portableRow('output', r)),
      outputTags: outputTags.map(r => portableRow('outputTag', r)),
      outputTagMaps: outputTagMaps.map(r => portableRow('outputTagMap', r)),
      txLabels: txLabels.map(r => portableRow('txLabel', r)),
      txLabelMaps: txLabelMaps.map(r => portableRow('txLabelMap', r)),
      certificates: certificates.map(r => {
        const row = portableRow('certificate', r)
        delete row.fields
        return row
      }),
      certificateFields: certificateFields.map(r => portableRow('certificateField', r)),
      syncStates: syncStates.map(r => portableRow('syncState', r))
    }
  }

  sortBRC38Tables(data.tables)
  validateBRC38(data)
  return data
}

export async function exportBRC38Json (storage: StorageProvider, identityKey: string): Promise<string> {
  return canonicalize(await exportBRC38(storage, identityKey))
}

export function parseBRC38Json (json: string): BRC38WalletData {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch (e) {
    throw new Error(`Invalid BRC-38 JSON: ${(e as Error).message}`)
  }
  return validateBRC38(data)
}

export async function importBRC38 (
  storage: StorageProvider,
  documentOrJson: BRC38WalletData | string,
  options: BRC38ImportOptions
): Promise<BRC38ImportResult> {
  const data = typeof documentOrJson === 'string' ? parseBRC38Json(documentOrJson) : validateBRC38(documentOrJson)
  const targetSettings = await storage.makeAvailable()
  const decoded = decodeBRC38(data)
  if (decoded.sourceStorage.chain !== targetSettings.chain) {
    throw new Error(`BRC-38 chain mismatch: payload is ${decoded.sourceStorage.chain}, target is ${targetSettings.chain}`)
  }
  if (options.mode === 'restore') return await restoreBRC38(storage, decoded)
  if (options.mode === 'merge') return await mergeBRC38(storage, decoded, targetSettings)
  throw new Error(`Unsupported BRC-38 import mode: ${String((options as { mode?: unknown }).mode)}`)
}

export async function exportBRC39 (
  storage: StorageProvider,
  identityKey: string,
  password: string,
  options?: BRC39Options
): Promise<number[]> {
  return await encryptBRC39(await exportBRC38(storage, identityKey), password, options)
}

export async function importBRC39 (
  storage: StorageProvider,
  bytes: number[] | Uint8Array,
  password: string,
  options: BRC38ImportOptions
): Promise<BRC38ImportResult> {
  return await importBRC38(storage, await decryptBRC39(bytes, password), options)
}

export async function encryptBRC39 (
  documentOrJson: BRC38WalletData | string,
  password: string,
  options?: BRC39Options
): Promise<number[]> {
  const data = typeof documentOrJson === 'string' ? parseBRC38Json(documentOrJson) : validateBRC38(documentOrJson)
  const plaintext = new Uint8Array(Utils.toArray(canonicalize(data), 'utf8'))
  const salt = new Uint8Array(Random(BRC39_SALT_LENGTH))
  const nonce = new Uint8Array(Random(BRC39_NONCE_LENGTH))
  const iterations = options?.iterations ?? BRC39_DEFAULT_ITERATIONS
  const memoryKiB = options?.memoryKiB ?? BRC39_DEFAULT_MEMORY_KIB
  const parallelism = options?.parallelism ?? BRC39_DEFAULT_PARALLELISM
  validateKdfParams(iterations, memoryKiB, parallelism, BRC39_HASH_LENGTH)
  validateExportKdfParams(iterations, memoryKiB)
  const key = await deriveBRC39Key(password, salt, iterations, memoryKiB, parallelism)
  const { result, authenticationTag } = AESGCM(plaintext, nonce, key)
  const header = new Uint8Array(BRC39_HEADER_LENGTH + salt.length + nonce.length)
  header.set(BRC39_MAGIC, 0)
  header[4] = 1
  header[5] = 1
  header[6] = 38
  header[7] = 1
  header[8] = 0
  header[9] = salt.length
  header[10] = nonce.length
  writeUInt32BE(header, 11, iterations)
  writeUInt32BE(header, 15, memoryKiB)
  header[19] = parallelism
  header[20] = BRC39_HASH_LENGTH
  header.set(salt, BRC39_HEADER_LENGTH)
  header.set(nonce, BRC39_HEADER_LENGTH + salt.length)
  return Array.from(concatBytes(header, result, authenticationTag))
}

export async function decryptBRC39 (bytes: number[] | Uint8Array, password: string): Promise<BRC38WalletData> {
  const file = new Uint8Array(bytes)
  if (file.length < BRC39_HEADER_LENGTH + BRC39_TAG_LENGTH + 2) throw new Error('Invalid BRC-39 file: too short')
  for (let i = 0; i < BRC39_MAGIC.length; i++) {
    if (file[i] !== BRC39_MAGIC[i]) throw new Error('Invalid BRC-39 file: bad magic')
  }
  if (file[4] !== 1) throw new Error('Unsupported BRC-39 format version')
  if (file[5] !== 1) throw new Error('Unsupported BRC-39 protector type')
  if (file[6] !== 38) throw new Error('Unsupported BRC-39 inner format')
  if (file[7] !== 1) throw new Error('Unsupported BRC-39 KDF type')
  if (file[8] !== 0) throw new Error('Invalid BRC-39 flags')
  const saltLength = file[9]
  const nonceLength = file[10]
  const iterations = readUInt32BE(file, 11)
  const memoryKiB = readUInt32BE(file, 15)
  const parallelism = file[19]
  const hashLength = file[20]
  for (let i = 21; i < BRC39_HEADER_LENGTH; i++) {
    if (file[i] !== 0) throw new Error('Invalid BRC-39 reserved bytes')
  }
  if (saltLength === 0) throw new Error('Invalid BRC-39 salt length')
  if (nonceLength === 0) throw new Error('Invalid BRC-39 nonce length')
  validateKdfParams(iterations, memoryKiB, parallelism, hashLength)
  const payloadStart = BRC39_HEADER_LENGTH + saltLength + nonceLength
  if (file.length <= payloadStart + BRC39_TAG_LENGTH) throw new Error('Invalid BRC-39 ciphertext')
  const salt = file.slice(BRC39_HEADER_LENGTH, BRC39_HEADER_LENGTH + saltLength)
  const nonce = file.slice(BRC39_HEADER_LENGTH + saltLength, payloadStart)
  const ciphertext = file.slice(payloadStart, file.length - BRC39_TAG_LENGTH)
  const tag = file.slice(file.length - BRC39_TAG_LENGTH)
  const key = await deriveBRC39Key(password, salt, iterations, memoryKiB, parallelism)
  const plaintext = AESGCMDecrypt(ciphertext, nonce, tag, key)
  if (plaintext == null) throw new Error('BRC-39 authentication failed')
  return parseBRC38Json(Utils.toUTF8(Array.from(plaintext)))
}

function validateBRC38 (value: unknown): BRC38WalletData {
  rejectNulls(value, 'document')
  if (!isObject(value)) throw new Error('BRC-38 document must be an object')
  const data = value as unknown as BRC38WalletData
  if (data.brc !== 38) throw new Error('BRC-38 document brc must equal 38')
  if (data.title !== BRC38_TITLE) throw new Error('BRC-38 title must equal User Wallet Data Format')
  if (data.formatVersion !== 1) throw new Error('BRC-38 formatVersion must equal 1')
  assertIsoDate(data.exportedAt, 'exportedAt')
  if (!isObject(data.sourceStorage)) throw new Error('BRC-38 sourceStorage must be an object')
  if (!isObject(data.user)) throw new Error('BRC-38 user must be an object')
  if (!isObject(data.tables)) throw new Error('BRC-38 tables must be an object')
  for (const name of tableNames) {
    if (!Array.isArray(data.tables[name])) throw new Error(`BRC-38 tables.${name} must be an array`)
  }
  validatePortableRows('settings', [data.sourceStorage], 'sourceStorage')
  validatePortableRows('user', [data.user], 'user')
  validatePortableRows('provenTx', data.tables.provenTxs, 'provenTxs')
  validatePortableRows('provenTxReq', data.tables.provenTxReqs, 'provenTxReqs')
  validatePortableRows('outputBasket', data.tables.outputBaskets, 'outputBaskets')
  validatePortableRows('transaction', data.tables.transactions, 'transactions')
  validatePortableRows('commission', data.tables.commissions, 'commissions')
  validatePortableRows('output', data.tables.outputs, 'outputs')
  validatePortableRows('outputTag', data.tables.outputTags, 'outputTags')
  validatePortableRows('outputTagMap', data.tables.outputTagMaps, 'outputTagMaps')
  validatePortableRows('txLabel', data.tables.txLabels, 'txLabels')
  validatePortableRows('txLabelMap', data.tables.txLabelMaps, 'txLabelMaps')
  validatePortableRows('certificate', data.tables.certificates, 'certificates')
  validatePortableRows('certificateField', data.tables.certificateFields, 'certificateFields')
  validatePortableRows('syncState', data.tables.syncStates, 'syncStates')
  validateRelationships(data)
  return data
}

function decodeBRC38 (data: BRC38WalletData): DecodedBRC38 {
  return {
    sourceStorage: fromPortableRow<TableSettings>('settings', data.sourceStorage),
    user: fromPortableRow<TableUser>('user', data.user),
    provenTxs: data.tables.provenTxs.map(r => fromPortableRow<TableProvenTx>('provenTx', r)),
    provenTxReqs: data.tables.provenTxReqs.map(r => fromPortableRow<TableProvenTxReq>('provenTxReq', r)),
    outputBaskets: data.tables.outputBaskets.map(r => fromPortableRow<TableOutputBasket>('outputBasket', r)),
    transactions: data.tables.transactions.map(r => fromPortableRow<TableTransaction>('transaction', r)),
    commissions: data.tables.commissions.map(r => fromPortableRow<TableCommission>('commission', r)),
    outputs: data.tables.outputs.map(r => fromPortableRow<TableOutput>('output', r)),
    outputTags: data.tables.outputTags.map(r => fromPortableRow<TableOutputTag>('outputTag', r)),
    outputTagMaps: data.tables.outputTagMaps.map(r => fromPortableRow<TableOutputTagMap>('outputTagMap', r)),
    txLabels: data.tables.txLabels.map(r => fromPortableRow<TableTxLabel>('txLabel', r)),
    txLabelMaps: data.tables.txLabelMaps.map(r => fromPortableRow<TableTxLabelMap>('txLabelMap', r)),
    certificates: data.tables.certificates.map(r => fromPortableRow<TableCertificate>('certificate', r)),
    certificateFields: data.tables.certificateFields.map(r => fromPortableRow<TableCertificateField>('certificateField', r)),
    syncStates: data.tables.syncStates.map(r => fromPortableRow<TableSyncState>('syncState', r))
  }
}

async function restoreBRC38 (storage: StorageProvider, data: DecodedBRC38): Promise<BRC38ImportResult> {
  await assertRestoreTargetEmpty(storage)
  await storage.transaction(async trx => {
    await storage.insertUser({ ...data.user }, trx)
    for (const row of data.provenTxs) await storage.insertProvenTx({ ...row }, trx)
    for (const row of data.outputBaskets) await storage.insertOutputBasket({ ...row }, trx)
    for (const row of data.outputTags) await storage.insertOutputTag({ ...row }, trx)
    for (const row of data.txLabels) await storage.insertTxLabel({ ...row }, trx)
    for (const row of data.transactions) await storage.insertTransaction({ ...row }, trx)
    for (const row of data.outputs) await storage.insertOutput({ ...row }, trx)
    for (const row of data.txLabelMaps) await storage.insertTxLabelMap({ ...row }, trx)
    for (const row of data.outputTagMaps) await storage.insertOutputTagMap({ ...row }, trx)
    for (const row of data.certificates) await storage.insertCertificate({ ...row }, trx)
    for (const row of data.certificateFields) await storage.insertCertificateField({ ...row }, trx)
    for (const row of data.commissions) await storage.insertCommission({ ...row }, trx)
    for (const row of data.provenTxReqs) await storage.insertProvenTxReq({ ...row }, trx)
    for (const row of data.syncStates) await storage.insertSyncState({ ...row }, trx)
  })
  return {
    mode: 'restore',
    identityKey: data.user.identityKey,
    userId: data.user.userId,
    inserts: 1 + countDecodedRows(data),
    updates: 0
  }
}

async function mergeBRC38 (
  storage: StorageProvider,
  data: DecodedBRC38,
  targetSettings: TableSettings
): Promise<BRC38ImportResult> {
  const { user: targetUser } = await storage.findOrInsertUser(data.user.identityKey)
  await storage.findOrInsertSyncStateAuth(
    { identityKey: data.user.identityKey, userId: targetUser.userId },
    data.sourceStorage.storageIdentityKey,
    data.sourceStorage.storageName
  )
  const chunk: sdk.SyncChunk = {
    fromStorageIdentityKey: data.sourceStorage.storageIdentityKey,
    toStorageIdentityKey: targetSettings.storageIdentityKey,
    userIdentityKey: data.user.identityKey,
    user: { ...data.user, activeStorage: targetUser.activeStorage },
    provenTxs: data.provenTxs.map(r => ({ ...r })),
    outputBaskets: data.outputBaskets.map(r => ({ ...r })),
    outputTags: data.outputTags.map(r => ({ ...r })),
    txLabels: data.txLabels.map(r => ({ ...r })),
    transactions: data.transactions.map(r => ({ ...r })),
    outputs: data.outputs.map(r => ({ ...r })),
    txLabelMaps: data.txLabelMaps.map(r => ({ ...r })),
    outputTagMaps: data.outputTagMaps.map(r => ({ ...r })),
    certificates: data.certificates.map(r => ({ ...r })),
    certificateFields: data.certificateFields.map(r => ({ ...r })),
    commissions: data.commissions.map(r => ({ ...r })),
    provenTxReqs: data.provenTxReqs.map(r => ({ ...r }))
  }
  const args = {
    fromStorageIdentityKey: chunk.fromStorageIdentityKey,
    toStorageIdentityKey: chunk.toStorageIdentityKey,
    identityKey: data.user.identityKey,
    maxRoughSize: Number.MAX_SAFE_INTEGER,
    maxItems: Number.MAX_SAFE_INTEGER,
    offsets: SYNC_CHUNK_ENTITY_ORDER.map(name => ({ name, offset: 0 }))
  }
  const first = await storage.processSyncChunk(args, chunk)
  const done = await storage.processSyncChunk(args, {
    fromStorageIdentityKey: chunk.fromStorageIdentityKey,
    toStorageIdentityKey: chunk.toStorageIdentityKey,
    userIdentityKey: data.user.identityKey,
    provenTxs: [],
    outputBaskets: [],
    outputTags: [],
    txLabels: [],
    transactions: [],
    outputs: [],
    txLabelMaps: [],
    outputTagMaps: [],
    certificates: [],
    certificateFields: [],
    commissions: [],
    provenTxReqs: []
  })
  const currentSyncState = verifyOne(
    await storage.findSyncStates({
      partial: {
        userId: targetUser.userId,
        storageIdentityKey: data.sourceStorage.storageIdentityKey,
        storageName: data.sourceStorage.storageName
      }
    })
  )
  const importMap = normalizeSyncMap(JSON.parse(currentSyncState.syncMap))
  const syncStateResult = await mergeImportedSyncStates(
    storage,
    data.syncStates,
    targetUser.userId,
    importMap,
    data.sourceStorage
  )
  return {
    mode: 'merge',
    identityKey: data.user.identityKey,
    userId: targetUser.userId,
    inserts: first.inserts + done.inserts + syncStateResult.inserts,
    updates: first.updates + done.updates + syncStateResult.updates
  }
}

async function mergeImportedSyncStates (
  storage: StorageProvider,
  syncStates: TableSyncState[],
  userId: number,
  importMap: SyncMap,
  sourceStorage: TableSettings
): Promise<{ inserts: number, updates: number }> {
  let inserts = 0
  let updates = 0
  for (const source of syncStates) {
    const row: TableSyncState = {
      ...source,
      userId,
      syncMap: JSON.stringify(remapSyncMap(JSON.parse(source.syncMap), importMap))
    }
    const existing = verifyOneOrNone(
      await storage.findSyncStates({
        partial: {
          userId,
          storageIdentityKey: row.storageIdentityKey,
          storageName: row.storageName
        }
      })
    )
    if (existing == null) {
      row.syncStateId = 0
      await storage.insertSyncState(row)
      inserts++
    } else {
      row.syncStateId = existing.syncStateId
      if (
        row.storageIdentityKey === sourceStorage.storageIdentityKey &&
        row.storageName === sourceStorage.storageName
      ) {
        row.syncMap = existing.syncMap
      }
      await storage.updateSyncState(existing.syncStateId, row)
      updates++
    }
  }
  return { inserts, updates }
}

function remapSyncMap (source: unknown, importMap: SyncMap): SyncMap {
  const copy = normalizeSyncMap(source)
  remapEntityIdMap(copy.provenTx.idMap, importMap.provenTx.idMap)
  remapEntityIdMap(copy.outputBasket.idMap, importMap.outputBasket.idMap)
  remapEntityIdMap(copy.transaction.idMap, importMap.transaction.idMap)
  remapEntityIdMap(copy.provenTxReq.idMap, importMap.provenTxReq.idMap)
  remapEntityIdMap(copy.txLabel.idMap, importMap.txLabel.idMap)
  remapEntityIdMap(copy.output.idMap, importMap.output.idMap)
  remapEntityIdMap(copy.outputTag.idMap, importMap.outputTag.idMap)
  remapEntityIdMap(copy.certificate.idMap, importMap.certificate.idMap)
  remapEntityIdMap(copy.commission.idMap, importMap.commission.idMap)
  return copy
}

function normalizeSyncMap (source: unknown): SyncMap {
  const normalized = createSyncMap()
  if (!isObject(source)) return normalized
  for (const key of Object.keys(normalized) as Array<keyof SyncMap>) {
    const incoming = source[key]
    if (!isObject(incoming)) continue
    const target = normalized[key]
    if (typeof incoming.entityName === 'string') target.entityName = incoming.entityName
    if (Number.isInteger(incoming.count)) target.count = incoming.count as number
    if (isObject(incoming.idMap)) {
      target.idMap = {}
      for (const [remoteId, localId] of Object.entries(incoming.idMap)) {
        const parsedRemoteId = Number(remoteId)
        if (Number.isInteger(parsedRemoteId) && Number.isInteger(localId)) {
          target.idMap[parsedRemoteId] = localId as number
        }
      }
    }
    if (typeof incoming.maxUpdated_at === 'string') {
      const maxUpdatedAt = new Date(incoming.maxUpdated_at)
      if (!Number.isNaN(maxUpdatedAt.getTime())) target.maxUpdated_at = maxUpdatedAt
    } else if (incoming.maxUpdated_at instanceof Date) {
      target.maxUpdated_at = incoming.maxUpdated_at
    }
  }
  return normalized
}

function remapEntityIdMap (idMap: Record<number, number>, importIdMap: Record<number, number>): void {
  for (const key of Object.keys(idMap)) {
    const targetId = importIdMap[idMap[Number(key)]]
    if (targetId != null) idMap[Number(key)] = targetId
  }
}

async function assertRestoreTargetEmpty (storage: StorageProvider): Promise<void> {
  const counts = await Promise.all([
    storage.countUsers({ partial: {} }),
    storage.countProvenTxs({ partial: {} }),
    storage.countProvenTxReqs({ partial: {} }),
    storage.countOutputBaskets({ partial: {} }),
    storage.countTransactions({ partial: {} }),
    storage.countCommissions({ partial: {} }),
    storage.countOutputs({ partial: {} }),
    storage.countOutputTags({ partial: {} }),
    storage.countOutputTagMaps({ partial: {} }),
    storage.countTxLabels({ partial: {} }),
    storage.countTxLabelMaps({ partial: {} }),
    storage.countCertificates({ partial: {} }),
    storage.countCertificateFields({ partial: {} }),
    storage.countSyncStates({ partial: {} }),
    storage.countMonitorEvents({ partial: {} })
  ])
  if (counts.some(c => c > 0)) throw new Error('BRC-38 restore requires an empty target storage except settings')
}

function countDecodedRows (data: DecodedBRC38): number {
  return data.provenTxs.length + data.provenTxReqs.length + data.outputBaskets.length + data.transactions.length +
    data.commissions.length + data.outputs.length + data.outputTags.length + data.outputTagMaps.length +
    data.txLabels.length + data.txLabelMaps.length + data.certificates.length + data.certificateFields.length +
    data.syncStates.length
}

function validateRelationships (data: BRC38WalletData): void {
  const userId = requireNumber(data.user.userId, 'user.userId')
  const txIds = ids(data.tables.transactions, 'transactionId', 'transactions')
  const txidValues = new Set(data.tables.transactions.map(t => t.txid).filter((v): v is string => typeof v === 'string'))
  const provenTxIds = ids(data.tables.provenTxs, 'provenTxId', 'provenTxs')
  const basketIds = ids(data.tables.outputBaskets, 'basketId', 'outputBaskets')
  const outputIds = ids(data.tables.outputs, 'outputId', 'outputs')
  const outputTagIds = ids(data.tables.outputTags, 'outputTagId', 'outputTags')
  const txLabelIds = ids(data.tables.txLabels, 'txLabelId', 'txLabels')
  const certificateIds = ids(data.tables.certificates, 'certificateId', 'certificates')
  for (const row of data.tables.transactions) {
    requireUserId(row, userId, 'transactions')
    if (row.provenTxId != null && !provenTxIds.has(requireNumber(row.provenTxId, 'transaction.provenTxId'))) {
      throw new Error('BRC-38 transaction.provenTxId does not reference an exported provenTx')
    }
  }
  for (const row of data.tables.outputBaskets) requireUserId(row, userId, 'outputBaskets')
  for (const row of data.tables.outputTags) requireUserId(row, userId, 'outputTags')
  for (const row of data.tables.txLabels) requireUserId(row, userId, 'txLabels')
  for (const row of data.tables.certificates) requireUserId(row, userId, 'certificates')
  for (const row of data.tables.syncStates) requireUserId(row, userId, 'syncStates')
  for (const row of data.tables.outputs) {
    requireUserId(row, userId, 'outputs')
    if (!txIds.has(requireNumber(row.transactionId, 'output.transactionId'))) {
      throw new Error('BRC-38 output.transactionId does not reference an exported transaction')
    }
    if (row.basketId != null && !basketIds.has(requireNumber(row.basketId, 'output.basketId'))) {
      throw new Error('BRC-38 output.basketId does not reference an exported output basket')
    }
    if (row.spentBy != null && !txIds.has(requireNumber(row.spentBy, 'output.spentBy'))) {
      throw new Error('BRC-38 output.spentBy does not reference an exported transaction')
    }
  }
  for (const row of data.tables.commissions) {
    requireUserId(row, userId, 'commissions')
    if (!txIds.has(requireNumber(row.transactionId, 'commission.transactionId'))) {
      throw new Error('BRC-38 commission.transactionId does not reference an exported transaction')
    }
  }
  for (const row of data.tables.txLabelMaps) {
    if (!txIds.has(requireNumber(row.transactionId, 'txLabelMap.transactionId'))) {
      throw new Error('BRC-38 txLabelMap.transactionId does not reference an exported transaction')
    }
    if (!txLabelIds.has(requireNumber(row.txLabelId, 'txLabelMap.txLabelId'))) {
      throw new Error('BRC-38 txLabelMap.txLabelId does not reference an exported transaction label')
    }
  }
  for (const row of data.tables.outputTagMaps) {
    if (!outputIds.has(requireNumber(row.outputId, 'outputTagMap.outputId'))) {
      throw new Error('BRC-38 outputTagMap.outputId does not reference an exported output')
    }
    if (!outputTagIds.has(requireNumber(row.outputTagId, 'outputTagMap.outputTagId'))) {
      throw new Error('BRC-38 outputTagMap.outputTagId does not reference an exported output tag')
    }
  }
  for (const row of data.tables.certificateFields) {
    requireUserId(row, userId, 'certificateFields')
    if (!certificateIds.has(requireNumber(row.certificateId, 'certificateField.certificateId'))) {
      throw new Error('BRC-38 certificateField.certificateId does not reference an exported certificate')
    }
  }
  for (const row of data.tables.provenTxReqs) {
    if (!txidValues.has(requireString(row.txid, 'provenTxReq.txid'))) {
      throw new Error('BRC-38 provenTxReq.txid does not match an exported transaction')
    }
    if (row.provenTxId != null && !provenTxIds.has(requireNumber(row.provenTxId, 'provenTxReq.provenTxId'))) {
      throw new Error('BRC-38 provenTxReq.provenTxId does not reference an exported provenTx')
    }
  }
}

function validatePortableRows (kind: string, rows: PortableRow[], path: string): void {
  const dateFields = new Set(dateFieldsByKind[kind] ?? [])
  const binaryFields = new Set(binaryFieldsByKind[kind] ?? [])
  const jsonFields = new Set(jsonFieldsByKind[kind] ?? [])
  for (const [index, row] of rows.entries()) {
    if (!isObject(row)) throw new Error(`BRC-38 ${path}[${index}] must be an object`)
    for (const field of dateFields) {
      if (field in row) assertIsoDate(row[field], `${path}[${index}].${field}`)
    }
    for (const field of binaryFields) {
      if (field in row) assertBase64(row[field], `${path}[${index}].${field}`)
    }
    for (const field of jsonFields) {
      if (field in row && !isObject(row[field])) throw new Error(`BRC-38 ${path}[${index}].${field} must be an object`)
    }
  }
}

function portableRow (kind: string, row: object): PortableRow {
  const out: PortableRow = {}
  const binaryFields = new Set(binaryFieldsByKind[kind] ?? [])
  const jsonFields = new Set(jsonFieldsByKind[kind] ?? [])
  for (const [key, value] of Object.entries(row)) {
    if (value == null) continue
    if (key === 'logger') continue
    if (binaryFields.has(key)) {
      out[key] = Utils.toBase64(value as number[])
    } else if (jsonFields.has(key)) {
      out[key] = typeof value === 'string' ? JSON.parse(value) as JsonValue : value as JsonValue
    } else if (value instanceof Date) {
      out[key] = isoDate(value)
    } else {
      out[key] = value as JsonValue
    }
  }
  return out
}

function fromPortableRow<T> (kind: string, row: PortableRow): T {
  const out: Record<string, unknown> = {}
  const dateFields = new Set(dateFieldsByKind[kind] ?? [])
  const binaryFields = new Set(binaryFieldsByKind[kind] ?? [])
  const jsonFields = new Set(jsonFieldsByKind[kind] ?? [])
  for (const [key, value] of Object.entries(row)) {
    if (dateFields.has(key)) out[key] = new Date(value as string)
    else if (binaryFields.has(key)) out[key] = Utils.toArray(value as string, 'base64')
    else if (jsonFields.has(key)) out[key] = JSON.stringify(value)
    else out[key] = value
  }
  return out as T
}

function sortBRC38Tables (tables: BRC38Tables): void {
  tables.provenTxs.sort(byNumber('provenTxId'))
  tables.provenTxReqs.sort(byNumber('provenTxReqId'))
  tables.outputBaskets.sort(byNumber('basketId'))
  tables.transactions.sort(byNumber('transactionId'))
  tables.commissions.sort(byNumber('commissionId'))
  tables.outputs.sort(byNumber('outputId'))
  tables.outputTags.sort(byNumber('outputTagId'))
  tables.outputTagMaps.sort(byNumber('outputId', 'outputTagId'))
  tables.txLabels.sort(byNumber('txLabelId'))
  tables.txLabelMaps.sort(byNumber('transactionId', 'txLabelId'))
  tables.certificates.sort(byNumber('certificateId'))
  tables.certificateFields.sort((a, b) => {
    const certificateIdOrder =
      requireNumber(a.certificateId, 'certificateId') - requireNumber(b.certificateId, 'certificateId')
    if (certificateIdOrder !== 0) return certificateIdOrder
    return requireString(a.fieldName, 'fieldName').localeCompare(requireString(b.fieldName, 'fieldName'))
  })
  tables.syncStates.sort(byNumber('syncStateId'))
}

function byNumber (field: string, secondField?: string): (a: PortableRow, b: PortableRow) => number {
  return (a, b) => {
    const first = requireNumber(a[field], field) - requireNumber(b[field], field)
    if (first !== 0 || secondField == null) return first
    return requireNumber(a[secondField], secondField) - requireNumber(b[secondField], secondField)
  }
}

function ids (rows: PortableRow[], field: string, label: string): Set<number> {
  const set = new Set<number>()
  for (const row of rows) {
    const id = requireNumber(row[field], `${label}.${field}`)
    if (set.has(id)) throw new Error(`BRC-38 duplicate ${label}.${field}: ${id}`)
    set.add(id)
  }
  return set
}

function requireUserId (row: PortableRow, userId: number, label: string): void {
  if (requireNumber(row.userId, `${label}.userId`) !== userId) throw new Error(`BRC-38 ${label}.userId does not match user.userId`)
}

function requireNumber (value: unknown, path: string): number {
  if (!Number.isInteger(value)) throw new Error(`BRC-38 ${path} must be an integer`)
  return value as number
}

function requireString (value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`BRC-38 ${path} must be a string`)
  return value
}

function assertIsoDate (value: unknown, path: string): void {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error(`BRC-38 ${path} must be a UTC ISO timestamp`)
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) throw new Error(`BRC-38 ${path} is invalid`)
}

function assertBase64 (value: unknown, path: string): void {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error(`BRC-38 ${path} must be padded base64`)
  }
}

function rejectNulls (value: unknown, path: string): void {
  if (value === null) throw new Error(`BRC-38 ${path} must omit null values`)
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) rejectNulls(value[i], `${path}[${i}]`)
  } else if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) rejectNulls(child, `${path}.${key}`)
  }
}

function canonicalize (value: unknown): string {
  if (value === null || value === undefined) throw new Error('Cannot canonicalize null or undefined')
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Cannot canonicalize non-finite number')
    return JSON.stringify(value)
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`
  }
  throw new Error(`Unsupported JSON value type: ${typeof value}`)
}

function isoDate (date: Date): string {
  return date.toISOString()
}

function isObject (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compareNumber (a: number, b: number): number {
  return a - b
}

function concatBytes (...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const array of arrays) {
    out.set(array, offset)
    offset += array.length
  }
  return out
}

async function deriveBRC39Key (
  password: string,
  salt: Uint8Array,
  iterations: number,
  memoryKiB: number,
  parallelism: number
): Promise<Uint8Array> {
  const normalized = password.normalize('NFC')
  const hash = await argon2id({
    password: new Uint8Array(Utils.toArray(normalized, 'utf8')),
    salt,
    iterations,
    memorySize: memoryKiB,
    parallelism,
    hashLength: BRC39_HASH_LENGTH,
    outputType: 'binary'
  })
  return new Uint8Array(hash)
}

function validateKdfParams (iterations: number, memoryKiB: number, parallelism: number, hashLength: number): void {
  if (!Number.isInteger(iterations) || iterations <= 0) throw new Error('Invalid BRC-39 Argon2id iterations')
  if (!Number.isInteger(memoryKiB) || memoryKiB <= 0) throw new Error('Invalid BRC-39 Argon2id memoryKiB')
  if (!Number.isInteger(parallelism) || parallelism <= 0 || parallelism > 255) throw new Error('Invalid BRC-39 Argon2id parallelism')
  if (hashLength !== BRC39_HASH_LENGTH) throw new Error('Invalid BRC-39 Argon2id hashLength')
}

function validateExportKdfParams (iterations: number, memoryKiB: number): void {
  if (iterations < BRC39_DEFAULT_ITERATIONS) {
    throw new Error('BRC-39 export iterations must not be weaker than the canonical default')
  }
  if (memoryKiB < BRC39_DEFAULT_MEMORY_KIB) {
    throw new Error('BRC-39 export memoryKiB must not be weaker than the canonical default')
  }
}

function writeUInt32BE (target: Uint8Array, offset: number, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error('BRC-39 integer out of range')
  target[offset] = (value >>> 24) & 0xff
  target[offset + 1] = (value >>> 16) & 0xff
  target[offset + 2] = (value >>> 8) & 0xff
  target[offset + 3] = value & 0xff
}

function readUInt32BE (source: Uint8Array, offset: number): number {
  return ((source[offset] << 24) >>> 0) + (source[offset + 1] << 16) + (source[offset + 2] << 8) + source[offset + 3]
}
