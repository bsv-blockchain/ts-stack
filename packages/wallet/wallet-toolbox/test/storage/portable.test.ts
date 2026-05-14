/* eslint-disable @typescript-eslint/triple-slash-reference */
/// <reference path="../../src/types/bsv-sdk-aesgcm.d.ts" />
/* eslint-enable @typescript-eslint/triple-slash-reference */

import { Utils } from '@bsv/sdk'
import { AESGCM } from '@bsv/sdk/primitives/AESGCM'
import { argon2id } from 'hash-wasm'
import {
  BRC38WalletData,
  decryptBRC39,
  encryptBRC39,
  exportBRC38,
  exportBRC38Json,
  importBRC38,
  parseBRC38Json,
  verifyOne,
  verifyTruthy
} from '../../src/index.client'
import { StorageKnex } from '../../src/storage/StorageKnex'
import { createSyncMap } from '../../src/storage/schema/entities/EntityBase'
import { _tu, TestSetup1Wallet } from '../utils/TestUtilsWalletStorage'

const iso = '2026-01-02T03:04:05.006Z'
const remoteSyncStorageIdentityKey = 'remote-sync-storage-identity-key'
const remoteSyncStorageName = 'remote-sync-storage'

describe('BRC-38/39 portable wallet data', () => {
  jest.setTimeout(99999999)

  const destroyers: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (destroyers.length > 0) {
      await destroyers.pop()!()
    }
  })

  test('validates canonical BRC-38 shape, nulls, base64, JSON fields, and relationships', () => {
    const nullDoc = cloneDocument(minimalDocument())
    nullDoc.user.activeStorage = null as unknown as string
    expect(() => parseBRC38Json(JSON.stringify(nullDoc))).toThrow(/omit null values/)

    const badBase64 = cloneDocument(minimalDocument())
    badBase64.tables.transactions.push({
      created_at: iso,
      updated_at: iso,
      transactionId: 1,
      userId: 1,
      inputBEEF: 'abc'
    })
    expect(() => parseBRC38Json(JSON.stringify(badBase64))).toThrow(/padded base64/)

    const badJsonField = cloneDocument(minimalDocument())
    badJsonField.tables.syncStates.push({
      created_at: iso,
      updated_at: iso,
      syncStateId: 1,
      userId: 1,
      storageIdentityKey: 'storage',
      storageName: 'storage',
      syncMap: '{}'
    })
    expect(() => parseBRC38Json(JSON.stringify(badJsonField))).toThrow(/syncMap must be an object/)

    const badRelationship = cloneDocument(minimalDocument())
    badRelationship.tables.outputs.push({
      created_at: iso,
      updated_at: iso,
      outputId: 1,
      userId: 1,
      transactionId: 99
    })
    expect(() => parseBRC38Json(JSON.stringify(badRelationship))).toThrow(/output\.transactionId/)
  })

  test('exports BRC-38 canonical JSON with timestamps, base64 bytes, decoded JSON fields, and sorted arrays', async () => {
    const source = await createPortableSource('portable_export', '1'.repeat(64))
    const json = await exportBRC38Json(source.activeStorage, source.identityKey)
    const parsed = parseBRC38Json(json)

    expect(json.startsWith('{"brc":38,"exportedAt":"')).toBe(true)
    expect(json).not.toContain(':null')
    expect(json).not.toContain('monitor_events')
    expect(parsed.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(parsed.tables.transactions.map(row => row.transactionId)).toEqual(
      [...parsed.tables.transactions.map(row => row.transactionId)].sort((a, b) => Number(a) - Number(b))
    )

    const txWithRaw = verifyTruthy(parsed.tables.transactions.find(row => row.rawTx != null))
    expect(txWithRaw.rawTx).toBe('AQID')
    expect(typeof parsed.tables.provenTxReqs[0].history).toBe('object')
    expect(parsed.tables.provenTxReqs[0].rawTx).toBe('BAUG')
    expect(parsed.tables.certificates.some(row => 'fields' in row)).toBe(false)
    expect(parsed.tables.syncStates.some(row => typeof row.syncMap === 'object')).toBe(true)
  })

  test('restores BRC-38 into empty SQLite storage while preserving semantic rows', async () => {
    const source = await createPortableSource('portable_restore_source', '2'.repeat(64))
    const document = await exportBRC38(source.activeStorage, source.identityKey)
    const target = await createEmptyStorage('portable_restore_target')
    const result = await importBRC38(target, document, { mode: 'restore' })
    const restored = await exportBRC38(target, source.identityKey)

    expect(result).toMatchObject({
      mode: 'restore',
      identityKey: source.identityKey,
      userId: document.user.userId
    })
    expect(restored.user).toEqual(document.user)
    expect(restored.tables).toEqual(document.tables)
    await expect(importBRC38(target, document, { mode: 'restore' })).rejects.toThrow(/empty target storage/)
  })

  test('merges BRC-38 into non-empty SQLite storage with ID and sync-map remapping', async () => {
    const rootKeyHex = '3'.repeat(64)
    const source = await createPortableSource('portable_merge_source', rootKeyHex)
    const document = await exportBRC38(source.activeStorage, source.identityKey)
    const target = await createPortableSource('portable_merge_target', rootKeyHex)
    const targetUserBefore = verifyTruthy(await target.activeStorage.findUserByIdentityKey(source.identityKey))

    const result = await importBRC38(target.activeStorage, document, { mode: 'merge' })
    const targetUserAfter = verifyTruthy(await target.activeStorage.findUserByIdentityKey(source.identityKey))
    const importSyncState = verifyOne(
      await target.activeStorage.findSyncStates({
        partial: {
          userId: targetUserAfter.userId,
          storageIdentityKey: document.sourceStorage.storageIdentityKey as string,
          storageName: document.sourceStorage.storageName as string
        }
      })
    )
    const importMap = JSON.parse(importSyncState.syncMap)
    const sourceTransactionId = document.tables.transactions[0].transactionId as number
    const targetTransactionId = importMap.transaction.idMap[sourceTransactionId]
    const sourceOutput = verifyTruthy(document.tables.outputs.find(row => row.transactionId === sourceTransactionId))
    const targetOutputId = importMap.output.idMap[sourceOutput.outputId as number]
    const targetOutput = verifyOne(await target.activeStorage.findOutputs({ partial: { outputId: targetOutputId } }))
    const sourceLabelMap = verifyTruthy(
      document.tables.txLabelMaps.find(row => row.transactionId === sourceTransactionId)
    )
    const targetLabelId = importMap.txLabel.idMap[sourceLabelMap.txLabelId as number]
    const targetLabelMap = verifyOne(
      await target.activeStorage.findTxLabelMaps({
        partial: { transactionId: targetTransactionId, txLabelId: targetLabelId }
      })
    )
    const sourceTagMap = verifyTruthy(document.tables.outputTagMaps.find(row => row.outputId === sourceOutput.outputId))
    const targetTagId = importMap.outputTag.idMap[sourceTagMap.outputTagId as number]
    const targetTagMap = verifyOne(
      await target.activeStorage.findOutputTagMaps({
        partial: { outputId: targetOutputId, outputTagId: targetTagId }
      })
    )
    const sourceCommission = verifyTruthy(
      document.tables.commissions.find(row => row.transactionId === sourceTransactionId)
    )
    const targetCommissionId = importMap.commission.idMap[sourceCommission.commissionId as number]
    const targetCommission = verifyOne(
      await target.activeStorage.findCommissions({ partial: { commissionId: targetCommissionId } })
    )
    const sourceCertificate = document.tables.certificates[0]
    const targetCertificateId = importMap.certificate.idMap[sourceCertificate.certificateId as number]
    const targetCertificate = verifyOne(
      await target.activeStorage.findCertificates({ partial: { certificateId: targetCertificateId } })
    )
    const sourceProvenTxReq = document.tables.provenTxReqs[0]
    const targetProvenTxReqId = importMap.provenTxReq.idMap[sourceProvenTxReq.provenTxReqId as number]
    const targetProvenTxReq = verifyOne(
      await target.activeStorage.findProvenTxReqs({ partial: { provenTxReqId: targetProvenTxReqId } })
    )
    const sourceRemoteSyncTransaction = verifyTruthy(
      document.tables.transactions.find(row => row.provenTxId === sourceProvenTxReq.provenTxId)
    )
    const targetRemoteSyncTransactionId = importMap.transaction.idMap[
      sourceRemoteSyncTransaction.transactionId as number
    ]
    const importedRemoteSyncState = verifyOne(
      await target.activeStorage.findSyncStates({
        partial: {
          userId: targetUserAfter.userId,
          storageIdentityKey: remoteSyncStorageIdentityKey,
          storageName: remoteSyncStorageName
        }
      })
    )
    const importedRemoteSyncMap = JSON.parse(importedRemoteSyncState.syncMap)

    expect(result.inserts).toBeGreaterThan(0)
    expect(targetUserAfter.activeStorage).toBe(targetUserBefore.activeStorage)
    expect(targetTransactionId).toBeGreaterThan(0)
    expect(targetTransactionId).not.toBe(sourceTransactionId)
    expect(targetOutput.transactionId).toBe(targetTransactionId)
    expect(targetOutput.basketId).toBe(importMap.outputBasket.idMap[sourceOutput.basketId as number])
    expect(targetLabelMap.isDeleted).toBe(sourceLabelMap.isDeleted)
    expect(targetTagMap.isDeleted).toBe(sourceTagMap.isDeleted)
    expect(targetCommission.transactionId).toBe(targetTransactionId)
    expect(targetCertificate.serialNumber).toBe(sourceCertificate.serialNumber)
    expect(targetProvenTxReq.provenTxId).toBe(importMap.provenTx.idMap[sourceProvenTxReq.provenTxId as number])
    expect(importedRemoteSyncMap.transaction.idMap[777]).toBe(targetRemoteSyncTransactionId)
    expect(importedRemoteSyncMap.output.idMap[778]).toBe(targetOutputId)
  })

  test('encrypts and decrypts BRC-39 with the expected header and normalized password', async () => {
    const document = minimalDocument()
    const bytes = await encryptBRC39(document, 'Cafe\u0301')
    const decoded = await decryptBRC39(bytes, 'Caf\u00e9')

    expect(bytes.slice(0, 4)).toEqual([0x57, 0x44, 0x41, 0x54])
    expect(bytes[4]).toBe(1)
    expect(bytes[5]).toBe(1)
    expect(bytes[6]).toBe(38)
    expect(bytes[7]).toBe(1)
    expect(bytes[8]).toBe(0)
    expect(bytes[9]).toBe(32)
    expect(bytes[10]).toBe(32)
    expect(readUInt32BE(bytes, 11)).toBe(7)
    expect(readUInt32BE(bytes, 15)).toBe(131072)
    expect(bytes[19]).toBe(1)
    expect(bytes[20]).toBe(32)
    expect(bytes.slice(21, 33)).toEqual(new Array(12).fill(0))
    expect(decoded).toEqual(document)
  })

  test('rejects invalid BRC-39 passwords, headers, parameters, tags, and plaintext', async () => {
    const document = minimalDocument()
    const bytes = await encryptBRC39(document, 'password')

    await expect(encryptBRC39(document, 'password', { iterations: 1 })).rejects.toThrow(/canonical default/)
    await expect(encryptBRC39(document, 'password', { memoryKiB: 64 })).rejects.toThrow(/canonical default/)
    await expect(decryptBRC39(bytes, 'wrong-password')).rejects.toThrow(/authentication failed/)
    await expect(decryptBRC39(withByte(bytes, 0, 0), 'password')).rejects.toThrow(/bad magic/)
    await expect(decryptBRC39(withByte(bytes, 4, 2), 'password')).rejects.toThrow(/format version/)
    await expect(decryptBRC39(withByte(bytes, 5, 2), 'password')).rejects.toThrow(/protector type/)
    await expect(decryptBRC39(withByte(bytes, 6, 39), 'password')).rejects.toThrow(/inner format/)
    await expect(decryptBRC39(withByte(bytes, 7, 2), 'password')).rejects.toThrow(/KDF type/)
    await expect(decryptBRC39(withByte(bytes, 8, 1), 'password')).rejects.toThrow(/flags/)
    await expect(decryptBRC39(withByte(bytes, 21, 1), 'password')).rejects.toThrow(/reserved/)
    await expect(decryptBRC39(withByte(bytes, 9, 0), 'password')).rejects.toThrow(/salt length/)
    await expect(decryptBRC39(withBytes(bytes, 11, [0, 0, 0, 0]), 'password')).rejects.toThrow(/iterations/)
    await expect(decryptBRC39(withByte(bytes, 20, 31), 'password')).rejects.toThrow(/hashLength/)
    await expect(decryptBRC39(withByte(bytes, bytes.length - 1, bytes[bytes.length - 1] ^ 1), 'password'))
      .rejects.toThrow(/authentication failed/)

    const nonBRC38 = await makeBRC39File('{"brc":37}', 'password')
    await expect(decryptBRC39(nonBRC38, 'password')).rejects.toThrow(/brc must equal 38/)
  })

  async function createPortableSource (databaseName: string, rootKeyHex: string): Promise<TestSetup1Wallet> {
    const ctx = await _tu.createSQLiteTestSetup1Wallet({
      databaseName,
      chain: 'test',
      rootKeyHex
    })
    destroyers.push(async () => {
      await ctx.storage.destroy()
    })

    const storage = ctx.activeStorage
    const user = verifyTruthy(ctx.setup?.u1)
    const proven = await _tu.insertTestProvenTx(storage)
    const { tx } = await _tu.insertTestTransaction(storage, user, false, {
      txid: proven.txid,
      provenTxId: proven.provenTxId
    })
    const req = await _tu.insertTestProvenTxReq(storage, proven.txid, proven.provenTxId)
    const remoteSyncState = await _tu.insertTestSyncState(storage, user)
    const remoteSyncMap = createSyncMap()
    remoteSyncMap.transaction.idMap[777] = tx.transactionId
    remoteSyncMap.output.idMap[778] = ctx.setup!.u1tx1o0.outputId
    remoteSyncMap.outputBasket.idMap[779] = ctx.setup!.u1basket1.basketId
    remoteSyncMap.txLabel.idMap[780] = ctx.setup!.u1label1.txLabelId
    remoteSyncMap.outputTag.idMap[781] = ctx.setup!.u1tag1.outputTagId
    remoteSyncMap.certificate.idMap[782] = ctx.setup!.u1cert1.certificateId
    remoteSyncMap.commission.idMap[783] = ctx.setup!.u1comm1.commissionId
    remoteSyncMap.provenTx.idMap[784] = proven.provenTxId
    remoteSyncMap.provenTxReq.idMap[785] = req.provenTxReqId
    await storage.updateSyncState(remoteSyncState.syncStateId, {
      storageIdentityKey: remoteSyncStorageIdentityKey,
      storageName: remoteSyncStorageName,
      syncMap: JSON.stringify(remoteSyncMap)
    })
    return ctx
  }

  async function createEmptyStorage (databaseName: string): Promise<StorageKnex> {
    const localSQLiteFile = await _tu.newTmpFile(`${databaseName}.sqlite`, false, false, false)
    const storage = new StorageKnex({
      ...StorageKnex.defaultOptions(),
      chain: 'test',
      knex: _tu.createLocalSQLite(localSQLiteFile)
    })
    destroyers.push(async () => {
      await storage.destroy()
    })
    await storage.dropAllData()
    await storage.migrate(databaseName, '1'.repeat(64))
    await storage.makeAvailable()
    return storage
  }
})

function minimalDocument (): BRC38WalletData {
  return {
    brc: 38,
    title: 'User Wallet Data Format',
    formatVersion: 1,
    exportedAt: iso,
    sourceStorage: {
      created_at: iso,
      updated_at: iso,
      storageIdentityKey: 'source-storage',
      storageName: 'source-storage',
      chain: 'test'
    },
    user: {
      created_at: iso,
      updated_at: iso,
      userId: 1,
      identityKey: 'identity-key',
      activeStorage: 'source-storage'
    },
    tables: {
      provenTxs: [],
      provenTxReqs: [],
      outputBaskets: [],
      transactions: [],
      commissions: [],
      outputs: [],
      outputTags: [],
      outputTagMaps: [],
      txLabels: [],
      txLabelMaps: [],
      certificates: [],
      certificateFields: [],
      syncStates: []
    }
  }
}

function cloneDocument (document: BRC38WalletData): BRC38WalletData {
  return JSON.parse(JSON.stringify(document)) as BRC38WalletData
}

function withByte (bytes: number[], offset: number, value: number): number[] {
  const copy = bytes.slice()
  copy[offset] = value
  return copy
}

function withBytes (bytes: number[], offset: number, values: number[]): number[] {
  const copy = bytes.slice()
  copy.splice(offset, values.length, ...values)
  return copy
}

function readUInt32BE (bytes: number[], offset: number): number {
  return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]
}

async function makeBRC39File (plaintext: string, password: string): Promise<number[]> {
  const iterations = 1
  const memoryKiB = 64
  const parallelism = 1
  const salt = new Uint8Array(32).fill(7)
  const nonce = new Uint8Array(32).fill(9)
  const key = new Uint8Array(
    await argon2id({
      password: new Uint8Array(Utils.toArray(password.normalize('NFC'), 'utf8')),
      salt,
      iterations,
      memorySize: memoryKiB,
      parallelism,
      hashLength: 32,
      outputType: 'binary'
    })
  )
  const encrypted = AESGCM(new Uint8Array(Utils.toArray(plaintext, 'utf8')), nonce, key)
  const header = new Uint8Array(97)
  header.set([0x57, 0x44, 0x41, 0x54], 0)
  header[4] = 1
  header[5] = 1
  header[6] = 38
  header[7] = 1
  header[9] = 32
  header[10] = 32
  writeUInt32BE(header, 11, iterations)
  writeUInt32BE(header, 15, memoryKiB)
  header[19] = parallelism
  header[20] = 32
  header.set(salt, 33)
  header.set(nonce, 65)
  return Array.from(concatBytes(header, encrypted.result, encrypted.authenticationTag))
}

function writeUInt32BE (target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff
  target[offset + 1] = (value >>> 16) & 0xff
  target[offset + 2] = (value >>> 8) & 0xff
  target[offset + 3] = value & 0xff
}

function concatBytes (...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, bytes) => sum + bytes.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const bytes of arrays) {
    out.set(bytes, offset)
    offset += bytes.length
  }
  return out
}
