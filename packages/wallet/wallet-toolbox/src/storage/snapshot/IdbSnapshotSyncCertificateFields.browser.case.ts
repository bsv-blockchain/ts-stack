import { deleteDB } from 'idb'
import { StorageIdb } from '../StorageIdb'
import { StorageProvider } from '../StorageProvider'
import { IdbSnapshotSyncDestination } from './IdbSnapshotSyncDestination'
import { IdbSnapshotSyncJournal } from './IdbSnapshotSyncJournal'
import { openPackedIdbSyncSource } from './openPackedIdbSyncSource'
import type { SnapshotSyncFieldPreparation } from './SnapshotSync'
import type { WalletReadSnapshot } from './WalletReadSnapshot'

// Logical database rows compare every JSON-visible value. Object insertion
// order is not a row invariant; array order and optional-value spelling remain.
function oracleJson(value: unknown): string | undefined {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) return undefined
  const ordered = (data: unknown): unknown => {
    if (Array.isArray(data)) return data.map(ordered)
    if (data !== null && typeof data === 'object') {
      const row = data as Record<string, unknown>
      return Object.fromEntries(
        Object.keys(row)
          .sort((a, b) => Number(a > b) - Number(a < b))
          .map(key => [key, ordered(row[key])])
      )
    }
    return data
  }
  return JSON.stringify(ordered(JSON.parse(serialized) as unknown))
}
function same(actual: unknown, expected: unknown): void {
  if (oracleJson(actual) !== oracleJson(expected))
    throw new Error('Independent certificate-field component oracle differs')
}
async function refused(action: () => Promise<unknown>): Promise<void> {
  let failed = false
  try {
    await action()
  } catch {
    failed = true
  }
  if (!failed) throw new Error('Certificate-field component accepted stale metadata')
}
/** Authored UNRUN actual browser-transaction case. Both source and target use
 * genuine operational packed providers/read factories/stages/journals. This
 * tests one component, not portable archive authentication, all-table replica
 * completion, funded restore/spend or production readiness. */
export async function verifyIdbSnapshotSyncCertificateFields(expiresAt: number): Promise<void> {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 120000)
    throw new Error('Original finite certificate component deadline required')
  const identityKey = '02' + '11'.repeat(32),
    dates = { created_at: new Date('2026-01-01'), updated_at: new Date('2026-01-01') },
    updated = new Date('2026-02-01'),
    text = '\ufeff' + '🙂µZ'.repeat(20000),
    keyText = 'key'.repeat(30000),
    options = {
      ...StorageProvider.createStorageBaseOptions('test'),
      packed: { maximumLogicalBytes: 33554432, maximumRecords: 20000 }
    },
    sourceStorage = new StorageIdb(options),
    target = new StorageIdb(options)
  sourceStorage.dbName = 'certificate-component-source-' + crypto.randomUUID()
  target.dbName = 'certificate-component-target-' + crypto.randomUUID()
  let source: WalletReadSnapshot | undefined, prepared: SnapshotSyncFieldPreparation | undefined
  try {
    await sourceStorage.migrate('Independent certificate source', 'source')
    await target.migrate('Independent occupied certificate target', 'target')
    await sourceStorage.db!.put('users', { ...dates, userId: 77, identityKey, activeStorage: 'source' })
    await target.db!.put('users', { ...dates, userId: 1, identityKey, activeStorage: 'target' })
    const certificate = {
      ...dates,
      type: 'AQ==',
      serialNumber: 'Ag==',
      certifier: identityKey,
      subject: identityKey,
      revocationOutpoint: '22'.repeat(32) + '.0',
      signature: '',
      isDeleted: false
    }
    const signature = 'signature'.repeat(20000)
    await sourceStorage.db!.put('certificates', {
      ...certificate,
      updated_at: updated,
      signature,
      userId: 77,
      certificateId: 21
    })
    await target.db!.put('certificates', { ...certificate, userId: 1, certificateId: 3 })
    const basket = { ...dates, name: 'ordinary', numberOfDesiredUTXOs: 0, minimumDesiredUTXOValue: 0, isDeleted: false }
    await target.db!.put('output_baskets', { ...basket, userId: 1, basketId: 7 })
    await sourceStorage.db!.put('output_baskets', {
      ...basket,
      updated_at: updated,
      userId: 77,
      basketId: 27,
      numberOfDesiredUTXOs: 8
    })
    const transaction = { ...dates, status: 'unprocessed' as const, isOutgoing: false, satoshis: 1, description: '' }
    const actionBytes = Array.from({ length: 70000 }, (_, index) => index % 251),
      reclaimTxid = '44'.repeat(32),
      unresolvedTxid = '55'.repeat(32)
    for (const [sourceId, targetId] of [
      [26, 8],
      [27, 9]
    ]) {
      await sourceStorage.db!.put('transactions', {
        ...transaction,
        updated_at: updated,
        transactionId: sourceId,
        userId: 77,
        reference: 'tx-' + targetId,
        rawTx: actionBytes,
        description: text,
        noSendExpiryState: targetId === 8 ? 'target-won' : 'reclaiming',
        noSendExpiryReclaimTxid: targetId === 8 ? reclaimTxid : unresolvedTxid,
        noSendExpiryReclaimDerivationPrefix: keyText
      })
      await target.db!.put('transactions', {
        ...transaction,
        transactionId: targetId,
        userId: 1,
        reference: 'tx-' + targetId,
        ...(targetId === 8
          ? {
              updated_at: new Date('2026-03-01'),
              noSendExpiryState: 'reclaimed',
              noSendExpiryReclaimTxid: reclaimTxid,
              rawTx: [1, 2, 3],
              description: 'newer ordinary fields'
            }
          : {})
      })
    }
    const output = {
      ...dates,
      transactionId: 9,
      userId: 1,
      outputId: 5,
      spendable: true,
      change: true,
      vout: 0,
      satoshis: 2,
      providedBy: 'you-and-storage' as const,
      purpose: 'change',
      type: 'P2PKH',
      outputDescription: '',
      txid: reclaimTxid
    }
    await target.db!.put('outputs', output)
    await sourceStorage.db!.put('outputs', {
      ...output,
      updated_at: updated,
      userId: 77,
      transactionId: 27,
      outputId: 51,
      txid: unresolvedTxid,
      basketId: 27,
      lockingScript: actionBytes,
      outputDescription: text,
      customInstructions: keyText
    })
    await sourceStorage.db!.put('outputs', {
      ...output,
      updated_at: updated,
      userId: 77,
      transactionId: 27,
      outputId: 52,
      vout: 1,
      txid: unresolvedTxid,
      basketId: 27,
      lockingScript: actionBytes,
      outputDescription: text
    })
    const incomingScript = Array.from({ length: 70000 }, (_, index) => index % 256),
      incomingOffset = 'offset'.repeat(20000),
      commission = { ...dates, satoshis: 3, isRedeemed: false, keyOffset: 'original', lockingScript: [8, 7, 6] }
    await target.db!.put('commissions', { ...commission, userId: 1, commissionId: 4, transactionId: 8 })
    await sourceStorage.db!.put('commissions', {
      ...commission,
      updated_at: updated,
      userId: 77,
      commissionId: 41,
      transactionId: 26,
      isRedeemed: true,
      satoshis: 999,
      lockingScript: incomingScript,
      keyOffset: incomingOffset
    })
    await sourceStorage.db!.put('commissions', {
      ...commission,
      updated_at: updated,
      userId: 77,
      commissionId: 42,
      transactionId: 27,
      lockingScript: incomingScript,
      keyOffset: incomingOffset
    })
    await sourceStorage.db!.put('certificate_fields', {
      ...dates,
      updated_at: updated,
      userId: 77,
      certificateId: 21,
      fieldName: 'name',
      fieldValue: text,
      masterKey: keyText
    })
    const original = {
      ...dates,
      userId: 1,
      certificateId: 3,
      fieldName: 'name',
      fieldValue: 'old value',
      masterKey: 'old key'
    }
    await target.db!.put('certificate_fields', original)
    source = await openPackedIdbSyncSource(sourceStorage, identityKey, { lifetimeMs: expiresAt - Date.now() })
    const destination = new IdbSnapshotSyncDestination(target, async () => new Map()),
      journal = await IdbSnapshotSyncJournal.open(target)
    let cp = await destination.begin(
      {
        version: 1,
        snapshotId: source.snapshotId,
        sourceStorage: source.sourceStorage,
        user: source.user,
        expiresAt: source.expiresAt
      },
      'source'
    )
    cp = (await journal.commit(cp, 1, null, async () => ({ inserts: 0, updates: 0 }))).checkpoint
    const basketPage = await source.fieldReader!.readMetadataPage('outputBaskets', undefined, {
      maxRows: 2,
      maxBytes: 262144
    })
    prepared = await destination.prepareScalarFields(cp, basketPage, source)
    const basketOutcome = await prepared.apply()
    same(basketOutcome.inserts, 0)
    same(basketOutcome.updates, 1)
    same(await target.db!.get('output_baskets', 7), {
      ...basket,
      updated_at: updated,
      userId: 1,
      basketId: 7,
      numberOfDesiredUTXOs: 8
    })
    await prepared.close()
    prepared = undefined
    cp = basketOutcome.checkpoint
    for (let table = 2; table < 4; table++)
      cp = (await journal.commit(cp, table + 1, null, async () => ({ inserts: 0, updates: 0 }))).checkpoint
    const transactionPage = await source.fieldReader!.readMetadataPage('transactions', undefined, {
      maxRows: 3,
      maxBytes: 262144
    })
    if (transactionPage.rows.some(row => row.fields.rawTx !== undefined))
      throw new Error('Transaction source hydrated raw payload')
    prepared = await destination.prepareTransactions(cp, transactionPage, source)
    const transactionOutcome = await prepared.apply()
    same(transactionOutcome.inserts, 0)
    same(transactionOutcome.updates, 2)
    const clockSkew = await target.db!.get('transactions', 8),
      ordinary = await target.db!.get('transactions', 9)
    same(clockSkew!.noSendExpiryState, 'target-won')
    same(clockSkew!.updated_at, new Date('2026-03-01'))
    same(clockSkew!.description, 'newer ordinary fields')
    same(Array.from(clockSkew!.rawTx!), [1, 2, 3])
    same(clockSkew!.noSendExpiryReclaimDerivationPrefix, keyText)
    same(Array.from(ordinary!.rawTx!), actionBytes)
    same(ordinary!.description, text)
    same(ordinary!.noSendExpiryState, 'reclaiming')
    same((await target.db!.get('outputs', 5))!.spendable, false)
    await prepared.close()
    prepared = undefined
    cp = transactionOutcome.checkpoint
    const outputPage = await source.fieldReader!.readMetadataPage('outputs', undefined, {
      maxRows: 3,
      maxBytes: 262144
    })
    prepared = await destination.prepareOutputs(cp, outputPage, source)
    const outputOutcome = await prepared.apply()
    same(outputOutcome.inserts, 1)
    same(outputOutcome.updates, 1)
    const outputCurrent = await target.db!.get('outputs', 5)
    same(outputCurrent!.spendable, false)
    same(outputCurrent!.basketId, 7)
    same(outputCurrent!.transactionId, 9)
    same(outputCurrent!.txid, reclaimTxid)
    same(outputCurrent!.outputDescription, text)
    same(outputCurrent!.customInstructions, keyText)
    same(Array.from(outputCurrent!.lockingScript!), actionBytes)
    const insertedOutput = await target.db!.getFromIndex('outputs', 'transactionId_vout_userId', [9, 1, 1])
    same(insertedOutput!.spendable, false)
    same(insertedOutput!.basketId, 7)
    same(insertedOutput!.txid, unresolvedTxid)
    same(Array.from(insertedOutput!.lockingScript!), actionBytes)
    if (insertedOutput!.outputId === 52) throw new Error('Output retained a source-selected local ID')
    await prepared.close()
    prepared = undefined
    cp = outputOutcome.checkpoint
    for (let table = 6; table < 8; table++)
      cp = (await journal.commit(cp, table + 1, null, async () => ({ inserts: 0, updates: 0 }))).checkpoint
    const certificatePage = await source.fieldReader!.readMetadataPage('certificates', undefined, {
      maxRows: 2,
      maxBytes: 262144
    })
    if (typeof certificatePage.rows[0].fields.signature === 'string')
      throw new Error('Certificate signature was unexpectedly hydrated')
    prepared = await destination.prepareCertificates(cp, certificatePage, source)
    const certificateOutcome = await prepared.apply()
    same(certificateOutcome.inserts, 0)
    same(certificateOutcome.updates, 1)
    same(await target.db!.get('certificates', 3), {
      ...certificate,
      updated_at: updated,
      signature,
      userId: 1,
      certificateId: 3
    })
    await prepared.close()
    prepared = undefined
    cp = certificateOutcome.checkpoint
    const page = await source.fieldReader!.readMetadataPage('certificateFields', undefined, {
      maxRows: 2,
      maxBytes: 262144
    })
    if (
      page.rows.length !== 1 ||
      typeof page.rows[0].fields.fieldValue === 'string' ||
      typeof page.rows[0].fields.masterKey === 'string'
    )
      throw new Error('Actual source unexpectedly hydrated large certificate fields')
    prepared = await destination.prepareCertificateFields(cp, page, source)
    const before = await destination.checkpoint(identityKey, 'source')
    // Exact current-row/data changes after preparation must refuse and leave
    // checkpoint unchanged. No stage descriptor can bypass the writer fence.
    await target.db!.put('certificate_fields', { ...original, fieldValue: 'concurrent change' })
    await refused(prepared.apply)
    same(await destination.checkpoint(identityKey, 'source'), before)
    same((await target.db!.get('certificate_fields', [3, 'name']))!.fieldValue, 'concurrent change')
    await prepared.close()
    prepared = undefined
    prepared = await destination.prepareCertificateFields(cp, page, source)
    const outcome = await prepared.apply()
    same(outcome.inserts, 0)
    same(outcome.updates, 1)
    same(outcome.checkpoint.tableIndex, 10)
    const actual = await target.db!.get('certificate_fields', [3, 'name'])
    same(actual, { ...original, updated_at: updated, fieldValue: text, masterKey: keyText })
    await refused(prepared.apply)
    await prepared.close()
    prepared = undefined
    cp = outcome.checkpoint
    const commissionPage = await source.fieldReader!.readMetadataPage('commissions', undefined, {
      maxRows: 3,
      maxBytes: 262144
    })
    prepared = await destination.prepareCommissions(cp, commissionPage, source)
    const commissionOutcome = await prepared.apply()
    same(commissionOutcome.inserts, 1)
    same(commissionOutcome.updates, 1)
    same(commissionOutcome.checkpoint.tableIndex, 11)
    same(await target.db!.get('commissions', 4), {
      ...commission,
      updated_at: updated,
      isRedeemed: true,
      userId: 1,
      commissionId: 4,
      transactionId: 8
    })
    const inserted = await target.db!.getAllFromIndex('commissions', 'transactionId', 9)
    same(inserted.length, 1)
    same(inserted[0].userId, 1)
    same(inserted[0].transactionId, 9)
    same(Array.from(inserted[0].lockingScript), incomingScript)
    same(inserted[0].keyOffset, incomingOffset)
    if (!Number.isSafeInteger(inserted[0].commissionId) || inserted[0].commissionId === 42)
      throw new Error('Commission retained a source-selected local ID')
    await prepared.close()
    prepared = undefined
    await target.destroy()
    same(
      await (await IdbSnapshotSyncJournal.open(target)).checkpoint(identityKey, 'source'),
      commissionOutcome.checkpoint
    )
    if (Date.now() >= expiresAt) throw new Error('Original certificate component deadline ended')
  } finally {
    try {
      await prepared?.close()
    } finally {
      try {
        await source?.close()
      } finally {
        try {
          await sourceStorage.destroy()
          await target.destroy()
        } finally {
          await deleteDB(sourceStorage.dbName)
          await deleteDB(target.dbName)
        }
      }
    }
  }
}
