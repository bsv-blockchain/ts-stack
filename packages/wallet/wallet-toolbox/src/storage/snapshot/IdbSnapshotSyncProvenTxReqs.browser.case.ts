import { deleteDB } from 'idb'
import { StorageIdb } from '../StorageIdb'
import { StorageProvider } from '../StorageProvider'
import { getPackedIdbConnection } from '../idbPackedConnection'
import { packedIdbStores, readPackedIdbClock } from '../idbPackedFields'
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
  if (oracleJson(actual) !== oracleJson(expected)) throw new Error('Independent request component oracle differs')
}
async function refused(work: () => Promise<unknown>): Promise<void> {
  let failed = false
  try {
    await work()
  } catch {
    failed = true
  }
  if (!failed) throw new Error('Request component accepted a stale or consumed effect')
}
/** Authored UNRUN genuine packed source/destination component case. Actual
 * transaction field merges establish the notification mappings. Explicit
 * expected histories/notifications are independent of the selector helpers.
 * Empty prerequisite journal transitions test this component only; they are
 * not all-table, authenticated archive or production qualification. */
export async function verifyIdbSnapshotSyncProvenTxReqs(
  expiresAt: number,
  observe?: (phase: string) => void
): Promise<void> {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 120000)
    throw new Error('Original finite request component deadline required')
  const identityKey = '02' + '11'.repeat(32),
    dates = { created_at: new Date('2026-01-01'), updated_at: new Date('2026-01-01') },
    updated = new Date('2026-02-01'),
    padding = '🙂\ud800µ'.repeat(15000),
    raw = Array.from({ length: 70000 }, (_, index) => index % 251),
    options = {
      ...StorageProvider.createStorageBaseOptions('test'),
      packed: { maximumLogicalBytes: 33554432, maximumRecords: 20000 }
    },
    sourceStorage = new StorageIdb(options),
    target = new StorageIdb(options),
    oldNote = {
      when: '2026-01-01T00:00:00.000Z',
      what: 'old',
      value: 1
    },
    newNote = {
      when: '2026-02-01T00:00:00.000Z',
      what: 'new'
    },
    originalHistory = { notes: [oldNote, oldNote], local: padding },
    originalNotify = {
      transactionIds: [9, 8, 9, 1.5, null, -0, 9007199254740992],
      local: 'keep'
    },
    request = {
      ...dates,
      status: 'unknown' as const,
      attempts: 2,
      notified: true,
      rawTx: [1],
      inputBEEF: [2, 3],
      history: '{}',
      notify: '{}',
      wasBroadcast: false,
      rebroadcastAttempts: 1
    }
  sourceStorage.dbName = 'request-component-source-' + crypto.randomUUID()
  target.dbName = 'request-component-target-' + crypto.randomUUID()
  let source: WalletReadSnapshot | undefined, prepared: SnapshotSyncFieldPreparation | undefined
  try {
    observe?.('initialize')
    await sourceStorage.migrate('Independent request source', 'source')
    await target.migrate('Occupied request target', 'target')
    await sourceStorage.db!.put('users', { ...dates, userId: 77, identityKey, activeStorage: 'source' })
    await target.db!.put('users', { ...dates, userId: 1, identityKey, activeStorage: 'target' })
    const transaction = { ...dates, status: 'unprocessed' as const, isOutgoing: false, satoshis: 1, description: '' }
    for (const [sourceId, targetId, txid] of [
      [26, 8, '66'.repeat(32)],
      [27, 9, '77'.repeat(32)],
      [28, 10, '88'.repeat(32)]
    ] as const) {
      await sourceStorage.db!.put('transactions', {
        ...transaction,
        transactionId: sourceId,
        userId: 77,
        txid,
        reference: 'request-' + targetId
      })
      await target.db!.put('transactions', {
        ...transaction,
        transactionId: targetId,
        userId: 1,
        txid,
        reference: 'request-' + targetId
      })
    }
    await target.db!.put('proven_tx_reqs', {
      ...request,
      provenTxReqId: 3,
      txid: '66'.repeat(32),
      history: JSON.stringify(originalHistory),
      notify: JSON.stringify(originalNotify)
    })
    const unchanged = {
      ...request,
      provenTxReqId: 4,
      txid: '77'.repeat(32),
      batch: 'same',
      notify: '{"transactionIds":[8]}'
    }
    await target.db!.put('proven_tx_reqs', unchanged)
    await sourceStorage.db!.put('proven_tx_reqs', {
      ...request,
      provenTxReqId: 31,
      txid: '66'.repeat(32),
      updated_at: updated,
      status: 'completed',
      attempts: 99,
      notified: true,
      rawTx: raw,
      inputBEEF: raw,
      history: JSON.stringify({ notes: [{ ...oldNote, additional: 'subset duplicate' }, newNote], remote: 'ignored' }),
      notify: JSON.stringify({ transactionIds: [26, 27, 26, 1.5, null], remote: 'ignored' })
    })
    await sourceStorage.db!.put('proven_tx_reqs', {
      ...unchanged,
      provenTxReqId: 32,
      notify: '{"transactionIds":[26,26]}'
    })
    await sourceStorage.db!.put('proven_tx_reqs', {
      ...request,
      provenTxReqId: 33,
      txid: '88'.repeat(32),
      batch: 'new',
      rawTx: raw,
      inputBEEF: raw,
      history: ' { "notes" : [], "extra" : "new" } ',
      notify: JSON.stringify({ transactionIds: [26, 999, -2, 0, 1.5], extra: padding })
    })
    source = await openPackedIdbSyncSource(sourceStorage, identityKey, { lifetimeMs: expiresAt - Date.now() })
    const destination = new IdbSnapshotSyncDestination(target, async () => new Map()),
      journal = await IdbSnapshotSyncJournal.open(target)
    let cp = await destination.begin(
      {
        version: 1,
        snapshotId: source.snapshotId,
        user: source.user,
        sourceStorage: source.sourceStorage,
        expiresAt: source.expiresAt
      },
      'source'
    )
    for (let table = 0; table < 4; table++)
      cp = (await journal.commit(cp, table + 1, null, async () => ({ inserts: 0, updates: 0 }))).checkpoint
    const transactionPage = await source.fieldReader!.readMetadataPage('transactions', undefined, {
      maxRows: 8,
      maxBytes: 262144
    })
    observe?.('prepare transaction mappings')
    prepared = await destination.prepareTransactions(cp, transactionPage, source)
    cp = (await prepared.apply()).checkpoint
    await prepared.close()
    prepared = undefined
    for (let table = 5; table < 11; table++)
      cp = (await journal.commit(cp, table + 1, null, async () => ({ inserts: 0, updates: 0 }))).checkpoint
    const page = await source.fieldReader!.readMetadataPage('provenTxReqs', undefined, { maxRows: 8, maxBytes: 262144 })
    same(page.rows.length, 3)
    if (page.rows.some(row => row.fields.rawTx !== undefined)) throw new Error('Request metadata hydrated raw payload')
    const clock = async () => {
        const tx = getPackedIdbConnection(target.db!)!.rawTransaction([], 'readonly'),
          value = await readPackedIdbClock(tx)
        await tx.done
        return value
      },
      originalClock = await clock()
    observe?.('prepare requests before membership refusal')
    prepared = await destination.prepareProvenTxReqs(cp, page, source)
    observe?.('refuse changed membership')
    const before = await destination.checkpoint(identityKey, 'source'),
      transaction8 = await target.db!.get('transactions', 8)
    await target.db!.put('transactions', { ...transaction8!, txid: '44'.repeat(32) })
    same((await clock()).transactionMembershipRevision, originalClock.transactionMembershipRevision! + 1)
    await refused(prepared.apply)
    same(await destination.checkpoint(identityKey, 'source'), before)
    await prepared.close()
    prepared = undefined
    await target.db!.put('transactions', transaction8!)
    same((await clock()).transactionMembershipRevision, originalClock.transactionMembershipRevision! + 2)
    const aborted = target.db!.transaction('transactions', 'readwrite')
    await aborted.objectStore('transactions').put({ ...transaction8!, txid: '55'.repeat(32) })
    aborted.abort()
    await refused(() => aborted.done)
    same((await clock()).transactionMembershipRevision, originalClock.transactionMembershipRevision! + 2)
    same((await target.db!.get('transactions', 8))!.txid, transaction8!.txid)
    const version = async (): Promise<unknown> => {
        const tx = getPackedIdbConnection(target.db!)!.rawTransaction([], 'readonly'),
          row = await tx.objectStore(packedIdbStores.heads).get(['proven_tx_reqs', 4])
        await tx.done
        return row?.revision
      },
      originalRevision = await version()
    observe?.('prepare requests before valid commit')
    prepared = await destination.prepareProvenTxReqs(cp, page, source)
    observe?.('commit requests')
    // Ordinary foreground edits change the wallet revision but preserve the
    // actual notification dependencies and must not invalidate preparation.
    await target.db!.put('transactions', { ...transaction8!, description: 'foreground write', status: 'completed' })
    same((await clock()).transactionMembershipRevision, originalClock.transactionMembershipRevision! + 2)
    if ((await clock()).revision <= originalClock.revision)
      throw new Error('Foreground writes did not advance actual wallet revisions')
    const outcome = await prepared.apply()
    same(outcome.inserts, 1)
    same(outcome.updates, 0)
    same(outcome.checkpoint.done, true)
    observe?.('verify stored values')
    const existing = await target.db!.get('proven_tx_reqs', 3)
    same(existing!.status, 'unknown')
    same(existing!.attempts, 2)
    same(existing!.provenTxId, undefined)
    same(Array.from(existing!.rawTx), [1])
    same(Array.from(existing!.inputBEEF!), [2, 3])
    same(existing!.wasBroadcast, false)
    same(existing!.rebroadcastAttempts, 1)
    same(existing!.notified, false)
    same(existing!.created_at, dates.created_at)
    same(existing!.updated_at, updated)
    same(existing!.history, JSON.stringify({ notes: [oldNote, oldNote, newNote], local: padding }))
    same(existing!.notify, '{"transactionIds":[0,8,9,9007199254740992],"local":"keep"}')
    same(await target.db!.get('proven_tx_reqs', 4), unchanged)
    same(await version(), originalRevision)
    // The mapped incoming ID already existed. Reset-only state must not write.
    same((await target.db!.get('proven_tx_reqs', 4))!.notified, true)
    const inserted = await target.db!.getFromIndex('proven_tx_reqs', 'txid', '88'.repeat(32))
    if (inserted === undefined || inserted.provenTxReqId === 33)
      throw new Error('Request retained a source-selected native ID')
    same(Array.from(inserted.rawTx), raw)
    same(Array.from(inserted.inputBEEF!), raw)
    same(inserted.history, '{"notes":[],"extra":"new"}')
    same(inserted.notify, JSON.stringify({ transactionIds: [8], extra: padding }))
    same(inserted.notified, false)
    await refused(prepared.apply)
    await prepared.close()
    prepared = undefined
    await target.destroy()
    same(await (await IdbSnapshotSyncJournal.open(target)).checkpoint(identityKey, 'source'), outcome.checkpoint)
    if (Date.now() >= expiresAt) throw new Error('Original request component deadline ended')
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
