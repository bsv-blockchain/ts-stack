import { deleteDB, openDB } from 'idb'
import { StorageIdb } from '../StorageIdb'
import { StorageProvider } from '../StorageProvider'
import { getPackedIdbConnection } from '../idbPackedConnection'
import { idbImportJournalStores } from '../idbImportJournalSchema'
import { Brc38IdbImportJournal, type Brc38IdbImportJournalOptions } from './Brc38IdbImportJournal'
import type { Brc38ImportJournalAdmission, Brc38ImportJournalStep } from './Brc38ImportJournalContract'
import { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { prepareBrc38IdbRestoreHistory } from './Brc38IdbRestoreHistory'
import { packedIdbStores } from '../idbPackedFields'
import { inspectBrc38IdbPackedReferenceInventory } from './Brc38IdbPackedReferenceInventory'
import { retireExpiredBrc38BrowserProfile } from './Brc38IdbProfileRetirementBrowser'
import { detachSnapshotSyncPage } from '../snapshot/SnapshotSyncRowData'
import { snapshotSyncTables, type SnapshotSyncCheckpoint } from '../snapshot/SnapshotSync'

// Authored UNRUN. Requires actual browser IndexedDB, WebCrypto and the current
// compiled provider. This qualifies only checkpoint atomicity when later run;
// a fixture receipt is never authentication, semantics or activation evidence.
function equal(a: unknown, b: unknown): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('Independent IDB import oracle differs')
}
async function rejects(run: () => Promise<unknown>): Promise<void> {
  let failed = false
  try {
    await run()
  } catch {
    failed = true
  }
  if (!failed) throw new Error('IDB import admitted a refused operation')
}
async function sha(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text),
    result = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)))
  return Array.from(result, value => value.toString(16).padStart(2, '0')).join('')
}
function identifier(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
}

/** Native deletion oracle: an absent name must require an upgrade, which is
 * aborted immediately. This probe never leaves a newly created candidate. */
async function requireNamespaceAbsent(databaseName: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let absent = false
    const request = indexedDB.open(databaseName)
    request.onupgradeneeded = () => {
      absent = true
      request.transaction!.abort()
    }
    request.onerror = () => (absent ? resolve() : reject(request.error))
    request.onsuccess = () => {
      request.result.close()
      reject(new Error('Retired namespace still exists'))
    }
  })
}
async function fixture(maximumWorking = 1048576) {
  const profileId = identifier(),
    storage = new StorageIdb({
      ...StorageProvider.createStorageBaseOptions('test'),
      packed: { maximumLogicalBytes: 4194304, maximumRecords: 10000 },
      isolatedRestore: { profileId }
    }),
    expiresAt = Date.now() + 120000,
    identityKey = '02' + '11'.repeat(32),
    targetStorageIdentityKey = 'isolated-browser-target',
    initialDestinationSha256 = await sha('independent empty profile fixture'),
    admission: Brc38ImportJournalAdmission = {
      scope: {
        importId: crypto.randomUUID(),
        bindingSha256: await sha('original binding'),
        archiveSha256: await sha('complete encrypted archive'),
        userId: 1
      },
      previewId: crypto.randomUUID(),
      originalLimitsJson: JSON.stringify([100, 4194304, 8388608, 65536, maximumWorking, expiresAt]),
      expiresAt,
      initialDestinationSha256,
      totalRows: 2,
      maximumStepRows: 1,
      maximumStepBytes: 65536,
      maximumMappedIds: 1,
      maximumJournalLogicalBytes: 8192
    },
    workingAllocation = new Brc38WorkingAllocation(maximumWorking),
    options: Brc38IdbImportJournalOptions = {
      profile: { chain: 'test', identityKey, targetStorageIdentityKey },
      maximumOriginalLogicalBytes: 4194304,
      maximumOriginalRowBytes: 65536,
      workingAllocation
    },
    user = {
      userId: 1,
      identityKey,
      activeStorage: '',
      created_at: new Date('2026-01-01'),
      updated_at: new Date('2026-01-01')
    },
    header = JSON.stringify({ originalPrimary: 'source-profile', identityKey }),
    row = {
      provenTxId: 2,
      txid: '22'.repeat(32),
      height: 1,
      index: 0,
      blockHash: '33'.repeat(32),
      merkleRoot: '44'.repeat(32),
      merklePath: [1],
      rawTx: [2],
      created_at: new Date('2026-01-01'),
      updated_at: new Date('2026-01-01')
    },
    original = JSON.stringify({ incomingId: -1, txid: row.txid }),
    headerStep: Brc38ImportJournalStep = {
      fromRow: 0,
      rows: 1,
      bytes: new TextEncoder().encode(header).length,
      mappedIds: 0,
      pageSha256: await sha(header)
    },
    rowStep: Brc38ImportJournalStep = {
      fromRow: 1,
      rows: 1,
      bytes: new TextEncoder().encode(original).length,
      mappedIds: 1,
      pageSha256: await sha(original)
    },
    headerDestination = await sha('independent header postimage fixture'),
    rowDestination = await sha('independent row postimage fixture')
  try {
    await storage.migrate('Isolated restore fixture', targetStorageIdentityKey)
  } catch (cause) {
    await storage.destroy()
    await deleteDB(storage.dbName)
    throw cause
  }
  const owner = getPackedIdbConnection(storage.db!)
  if (owner === undefined) throw new Error('Genuine current packed provider absent')
  return {
    storage,
    owner,
    admission,
    options,
    workingAllocation,
    user,
    row,
    header,
    original,
    headerStep,
    rowStep,
    headerDestination,
    rowDestination
  }
}
export async function verifyIdbImportAtomicRollbackLostAckAndOriginalMappings(): Promise<void> {
  const f = await fixture(),
    inspection = await openDB(f.storage.dbName, 7)
  let journal = await Brc38IdbImportJournal.open(f.owner, f.admission, f.options)
  try {
    const prepared = await journal.prepare(f.admission.initialDestinationSha256)
    equal(prepared.nextRow, 0)
    const preparedSha = await sha(JSON.stringify(prepared)),
      initialRead = await journal.readMappings(preparedSha, [{ entity: 'provenTx', incomingId: -1, required: false }])
    equal(initialRead.mappings, [{ entity: 'provenTx', incomingId: -1 }])
    if (f.workingAllocation.used === 0) throw new Error('Retained mapping data lost its original allocation')
    initialRead.close()
    initialRead.close()
    equal(f.workingAllocation.used, 0)
    await rejects(() => journal.readMappings(preparedSha, [{ entity: 'provenTx', incomingId: -1, required: true }]))
    await rejects(() =>
      journal.readMappings(
        preparedSha,
        Array.from({ length: 129 }, () => ({ entity: 'provenTx' as const, incomingId: -1, required: false }))
      )
    )
    let staleApplied = false
    await rejects(() =>
      journal.commit(
        f.headerStep,
        prepared.destinationSha256,
        async () => {
          staleApplied = true
          return f.headerDestination
        },
        'f'.repeat(64)
      )
    )
    equal(staleApplied, false)
    const header = await journal.commit(f.headerStep, prepared.destinationSha256, async writer => {
      await writer.transaction.objectStore('users').add(f.user)
      await writer.original('header', 0, f.header)
      return f.headerDestination
    })
    equal([header.nextRow, header.sequence, header.state], [1, 1, 'COMMITTED'])
    await rejects(() => journal.readMappings(preparedSha, []))
    await journal.close()
    journal = await Brc38IdbImportJournal.open(f.owner, f.admission, f.options)
    equal(await journal.read(), header)
    let replayed = false
    equal(
      await journal.commit(f.headerStep, f.headerDestination, async () => {
        replayed = true
        throw new Error('Must not reapply')
      }),
      header
    )
    equal(replayed, false)
    const before = await inspection.get('_wallet_packed_clock', 'clock')
    await rejects(() =>
      journal.commit(f.rowStep, f.headerDestination, async writer => {
        await writer.transaction.objectStore('proven_txs').add(f.row)
        await writer.map('provenTx', -1, f.row.provenTxId)
        await writer.original('provenTxs', 0, f.original)
        throw new Error('Independent failure after all provisional row/map/original effects')
      })
    )
    equal(await inspection.get('_wallet_packed_clock', 'clock'), before)
    equal(await inspection.count('proven_txs'), 0)
    equal(await inspection.count(idbImportJournalStores.ids), 0)
    equal(await inspection.count(idbImportJournalStores.originals), 1)
    equal(await journal.read(), header)
    const complete = await journal.commit(f.rowStep, f.headerDestination, async writer => {
      equal(await writer.lookup('provenTx', -1), undefined)
      await writer.transaction.objectStore('proven_txs').add(f.row)
      await writer.map('provenTx', -1, f.row.provenTxId)
      equal(await writer.lookup('provenTx', -1), 2)
      await writer.original('provenTxs', 0, f.original)
      return f.rowDestination
    })
    equal([complete.nextRow, complete.sequence, complete.state, complete.mappedIds], [2, 2, 'COMPLETE', 1])
    const mapped = await journal.readMappings(await sha(JSON.stringify(complete)), [
      { entity: 'provenTx', incomingId: -1, required: true },
      { entity: 'transaction', incomingId: 0, required: false }
    ])
    equal(mapped.mappings, [
      { entity: 'provenTx', incomingId: -1, localId: 2 },
      { entity: 'transaction', incomingId: 0 }
    ])
    mapped.close()
    equal(await inspection.get(idbImportJournalStores.ids, ['provenTx', '-1']), {
      entity: 'provenTx',
      incomingId: '-1',
      localId: 2
    })
    equal(await inspection.get(idbImportJournalStores.originals, ['provenTxs', 0]), {
      table: 'provenTxs',
      index: 0,
      payload: f.original,
      sha256: await sha(f.original),
      bytes: new TextEncoder().encode(f.original).length,
      references: []
    })
    await rejects(() =>
      journal.commit({ ...f.rowStep, pageSha256: 'f'.repeat(64) }, f.rowDestination, async () => f.rowDestination)
    )
    equal(f.workingAllocation.used, 0)
  } finally {
    await journal.close()
    inspection.close()
    await f.storage.destroy()
    await deleteDB(f.storage.dbName)
  }
}
export async function verifyIdbImportRejectsDriftResumeGrowthAndCopiedOwners(): Promise<void> {
  const f = await fixture(),
    journal = await Brc38IdbImportJournal.open(f.owner, f.admission, f.options)
  try {
    await journal.prepare(f.admission.initialDestinationSha256)
    const copied = Object.create(Object.getPrototypeOf(f.owner)) as typeof f.owner
    await rejects(() => Brc38IdbImportJournal.open(copied, f.admission, f.options))
    await rejects(() =>
      Brc38IdbImportJournal.open(
        f.owner,
        {
          ...f.admission,
          expiresAt: f.admission.expiresAt + 1000,
          originalLimitsJson: JSON.stringify([100, 4194304, 8388608, 65536, 1048576, f.admission.expiresAt + 1000])
        },
        f.options
      )
    )
    await rejects(() =>
      Brc38IdbImportJournal.open(f.owner, f.admission, { ...f.options, maximumOriginalLogicalBytes: 4194303 })
    )
    // An inactive candidate must refuse generic foreground writes. Exercise
    // drift through another genuine enrolled restore writer instead: restoring
    // the same profile values does not erase its observed revision changes.
    await rejects(() => f.storage.db!.put('users', f.user))
    const drift = f.owner.restoreTransaction(['users'], 'readwrite')
    try {
      await drift.wallet.objectStore('users').put(f.user)
      await drift.wallet.objectStore('users').delete(1)
      await f.owner.sealRestoreEffects(drift.wallet)
      await drift.journal.done
    } catch (cause) {
      f.owner.abandonRestoreEffects(drift.wallet)
      await drift.journal.done.catch(() => undefined)
      throw cause
    }
    await rejects(() => journal.read())
    equal(f.workingAllocation.used, 0)
  } finally {
    await journal.close()
    await f.storage.destroy()
    await deleteDB(f.storage.dbName)
  }
}
export async function verifyIdbInactiveHistoryUsesCurrentMappingAndOriginalAllocation(): Promise<void> {
  const f = await fixture(),
    journal = await Brc38IdbImportJournal.open(f.owner, f.admission, f.options)
  try {
    const prepared = await journal.prepare(f.admission.initialDestinationSha256)
    const header = await journal.commit(f.headerStep, prepared.destinationSha256, async writer => {
      await writer.transaction.objectStore('users').add(f.user)
      await writer.original('header', 0, f.header)
      return f.headerDestination
    })
    const complete = await journal.commit(f.rowStep, header.destinationSha256, async writer => {
      await writer.transaction.objectStore('proven_txs').add(f.row)
      await writer.map('provenTx', -1, 2)
      await writer.original('provenTxs', 0, f.original)
      return f.rowDestination
    })
    const original =
        ' {"provenTx":{"entityName":"historicalProofs","count":71,"maxUpdated_at":"2026-01-01",' +
        '"idMap":{"0":-1,"-5":-1,"2":99}},"transaction":{"count":8,"idMap":{"9":0}}} ',
      history = await prepareBrc38IdbRestoreHistory(journal, complete, 'syncMap', original, 8192)
    try {
      const mapped = JSON.parse(history.projection.mappedJson)
      equal(mapped.provenTx, {
        count: 71,
        entityName: 'historicalProofs',
        idMap: { '0': 2, '-5': 2 },
        maxUpdated_at: '2026-01-01T00:00:00.000Z'
      })
      equal(mapped.transaction, { count: 8, entityName: 'transaction', idMap: {} })
      equal(
        [history.projection.originalJson, history.projection.unmappedIds, history.projection.activated],
        [original, 2, false]
      )
      equal(
        Object.keys(mapped).sort((a, b) => Number(a > b) - Number(a < b)),
        [
          'certificate',
          'certificateField',
          'commission',
          'output',
          'outputBasket',
          'outputTag',
          'outputTagMap',
          'provenTx',
          'provenTxReq',
          'transaction',
          'txLabel',
          'txLabelMap'
        ].sort((a, b) => Number(a > b) - Number(a < b))
      )
      if (f.workingAllocation.used === 0) throw new Error('History reservation was released before its prepared data')
    } finally {
      history.close()
      history.close()
    }
    equal(f.workingAllocation.used, 0)
    const notify = await prepareBrc38IdbRestoreHistory(
      journal,
      complete,
      'notify',
      '{"transactionIds":[-1,-1,0,"ignored",1.5],"other":"preserved"}',
      4096
    )
    try {
      equal(JSON.parse(notify.projection.mappedJson), { other: 'preserved', transactionIds: [] })
      equal(notify.projection.unmappedIds, 2)
    } finally {
      notify.close()
    }
    await rejects(() => prepareBrc38IdbRestoreHistory(journal, header, 'syncMap', '{}', 4096))
    await rejects(() => prepareBrc38IdbRestoreHistory(journal, complete, 'notify', '[]', 4096))
    await rejects(() => prepareBrc38IdbRestoreHistory(journal, complete, 'syncMap', '{}', 1))
    const stopped = new AbortController()
    stopped.abort(new Error('Original history caller stopped'))
    await rejects(() => prepareBrc38IdbRestoreHistory(journal, complete, 'notify', '{}', 4096, stopped.signal))
    equal(f.workingAllocation.used, 0)
  } finally {
    await journal.close()
    await f.storage.destroy()
    await deleteDB(f.storage.dbName)
  }
}
export async function verifyIdbImportOriginalWorkingRefusalAndNamespaceDefaults(): Promise<void> {
  const f = await fixture(),
    inspection = await openDB(f.storage.dbName, 7),
    original = new Brc38WorkingAllocation(8192)
  try {
    await rejects(() => Brc38IdbImportJournal.open(f.owner, f.admission, { ...f.options, workingAllocation: original }))
    equal(original.used, 0)
    equal(await inspection.count(idbImportJournalStores.journal), 0)
    equal(new StorageIdb(StorageProvider.createStorageBaseOptions('test')).dbName, 'wallet-toolbox-testnet')
    equal(
      new StorageIdb({ ...StorageProvider.createStorageBaseOptions('test'), packed: {} }).dbName,
      'wallet-toolbox-testnet-packed-v1'
    )
    await rejects(
      async () =>
        new StorageIdb({
          ...StorageProvider.createStorageBaseOptions('test'),
          isolatedRestore: { profileId: identifier() }
        })
    )
  } finally {
    inspection.close()
    await f.storage.destroy()
    await deleteDB(f.storage.dbName)
  }
}
export async function verifyIdbImportRejectsUnawaitedProviderAndMapperEffects(): Promise<void> {
  const f = await fixture(),
    inspection = await openDB(f.storage.dbName, 7),
    journal = await Brc38IdbImportJournal.open(f.owner, f.admission, f.options)
  try {
    const original = await journal.prepare(f.admission.initialDestinationSha256),
      clock = await inspection.get('_wallet_packed_clock', 'clock')
    await rejects(() =>
      journal.commit(f.headerStep, original.destinationSha256, async writer => {
        await writer.original('header', 0, f.header)
        return f.headerDestination
      })
    )
    equal(await inspection.count(idbImportJournalStores.originals), 0)
    equal(await journal.read(), original)
    await rejects(() =>
      journal.commit(f.headerStep, original.destinationSha256, async writer => {
        await writer.transaction.objectStore('users').add(f.user)
        await writer.transaction.objectStore('users').put(f.user)
        await writer.original('header', 0, f.header)
        return f.headerDestination
      })
    )
    equal(await inspection.count('users'), 0)
    equal(await inspection.get('_wallet_packed_clock', 'clock'), clock)
    equal(await journal.read(), original)
    await rejects(() =>
      journal.commit(f.headerStep, original.destinationSha256, async writer => {
        void writer.transaction
          .objectStore('users')
          .add(f.user)
          .catch(() => undefined)
        return f.headerDestination
      })
    )
    equal(await inspection.count('users'), 0)
    equal(await inspection.get('_wallet_packed_clock', 'clock'), clock)
    equal(await journal.read(), original)
    await rejects(() =>
      journal.commit(f.headerStep, original.destinationSha256, async writer => {
        void writer.map('provenTx', 1, 1)
        return f.headerDestination
      })
    )
    equal(await inspection.count(idbImportJournalStores.ids), 0)
    equal(await inspection.get('_wallet_packed_clock', 'clock'), clock)
    equal(await journal.read(), original)
    equal(f.workingAllocation.used, 0)
  } finally {
    await journal.close()
    inspection.close()
    await f.storage.destroy()
    await deleteDB(f.storage.dbName)
  }
}
export async function verifyIsolatedIdbRestorePreservesHistoricalPolicyAcrossReopen(): Promise<void> {
  const profileId = identifier(),
    options = {
      ...StorageProvider.createStorageBaseOptions('test'),
      packed: { maximumLogicalBytes: 4194304, maximumRecords: 10000 },
      isolatedRestore: { profileId }
    },
    original = new StorageIdb(options),
    stamp = new Date('2026-01-01'),
    basket = {
      basketId: 1,
      userId: 1,
      name: 'default',
      numberOfDesiredUTXOs: 144,
      minimumDesiredUTXOValue: 32,
      isDeleted: false,
      created_at: stamp,
      updated_at: stamp
    }
  let reopened: StorageIdb | undefined
  try {
    await original.migrate('Historical restore policy fixture', 'historical-restore-profile')
    // Explicit genuine restore row-effect fixture. Ordinary candidate writes
    // now refuse until authenticated publication/activation; this is not a
    // complete import, archive proof or activation grant.
    await rejects(async () => await original.db!.put('output_baskets', basket))
    const owner = getPackedIdbConnection(original.db!)
    if (owner === undefined) throw new Error('Actual historical fixture owner absent')
    const writer = owner.restoreTransaction(['output_baskets'], 'readwrite')
    try {
      await writer.wallet.objectStore('output_baskets').add(basket)
      await owner.sealRestoreEffects(writer.wallet)
      await writer.journal.done
    } catch (cause) {
      owner.abandonRestoreEffects(writer.wallet)
      await writer.journal.done.catch(() => undefined)
      throw cause
    }
    const inspection = await openDB(original.dbName, 7)
    let clock: unknown
    try {
      clock = await inspection.get('_wallet_packed_clock', 'clock')
    } finally {
      inspection.close()
    }
    await original.destroy()
    reopened = new StorageIdb(options)
    await reopened.migrate('Historical restore policy fixture', 'historical-restore-profile')
    const restored = await reopened.db!.get('output_baskets', 1)
    equal(restored?.minimumDesiredUTXOValue, 32)
    equal(restored?.numberOfDesiredUTXOs, 144)
    equal(restored?.updated_at.getTime(), stamp.getTime())
    const after = await openDB(original.dbName, 7)
    try {
      equal(await after.get('_wallet_packed_clock', 'clock'), clock)
    } finally {
      after.close()
    }
  } finally {
    await reopened?.destroy()
    await original.destroy()
    await deleteDB(original.dbName)
  }
}

/** Real native rollback/reference/checkpoint coupling, authored UNRUN. Synthetic
 * content is deliberately not a valid transaction or encrypted archive proof. */
export async function verifyIdbStreamedOriginalReferencesAreAtomicWithRowsAndCheckpoint(): Promise<void> {
  const f = await fixture(4194304),
    journal = await Brc38IdbImportJournal.open(f.owner, f.admission, f.options),
    inspector = await openDB(f.storage.dbName, 7),
    bytes = Uint8Array.from({ length: 98304 }, (_, index) => index % 251),
    nativeHash = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))),
    sha256 = Array.from(nativeHash, byte => byte.toString(16).padStart(2, '0')).join(''),
    stage = await f.storage.beginPackedStorageField({
      kind: 'array',
      bytes: bytes.length,
      sha256,
      expiresAt: f.admission.expiresAt
    })
  try {
    await stage.append(0, bytes.subarray(0, 65536))
    await stage.append(65536, bytes.subarray(65536))
    await stage.finish()
    const descriptor = stage.descriptor,
      prepared = await journal.prepare(f.admission.initialDestinationSha256),
      header = await journal.commit(f.headerStep, prepared.destinationSha256, async writer => {
        await writer.transaction.objectStore('users').add(f.user)
        await writer.original('header', 0, f.header)
        return f.headerDestination
      }),
      before = await inspector.get(packedIdbStores.clock, 'clock'),
      { rawTx: _raw, ...row } = f.row
    await rejects(() =>
      journal.commit(f.rowStep, header.destinationSha256, async writer => {
        await f.storage.writeStagedStorageRow('proven_txs', row, { rawTx: stage }, 'add', writer.transaction)
        await writer.map('provenTx', -1, 2)
        await writer.originalStreamed('provenTxs', 0, f.original, { rawTx: stage })
        throw new Error('Independent failure after genuine row and original references plus map')
      })
    )
    equal(await journal.read(), header)
    equal(await inspector.get(packedIdbStores.clock, 'clock'), before)
    equal(await inspector.count('proven_txs'), 0)
    equal(await inspector.count(idbImportJournalStores.ids), 0)
    equal(await inspector.count(idbImportJournalStores.originals), 1)
    equal((await inspector.get(packedIdbStores.contents, descriptor.content)).refs, 0)
    const copied = Object.create(Object.getPrototypeOf(stage)) as typeof stage
    await rejects(() =>
      journal.commit(f.rowStep, header.destinationSha256, async writer => {
        await writer.originalStreamed('provenTxs', 0, f.original, { rawTx: copied })
        return f.rowDestination
      })
    )
    equal(await journal.read(), header)
    equal((await inspector.get(packedIdbStores.contents, descriptor.content)).refs, 0)
    const complete = await journal.commit(f.rowStep, header.destinationSha256, async writer => {
      await f.storage.writeStagedStorageRow('proven_txs', row, { rawTx: stage }, 'add', writer.transaction)
      await writer.map('provenTx', -1, 2)
      await writer.originalStreamed('provenTxs', 0, f.original, { rawTx: stage })
      // Same actual stage/data is idempotent within this one writer; no extra
      // original row/reference is created by repeating the acknowledged effect.
      await writer.originalStreamed('provenTxs', 0, f.original, { rawTx: stage })
      return f.rowDestination
    })
    const original = await inspector.get(idbImportJournalStores.originals, ['provenTxs', 0])
    equal(JSON.parse(original.fieldsJson), { rawTx: descriptor })
    equal(original.extentBytes, bytes.length)
    equal([complete.state, complete.nextRow, complete.mappedIds], ['COMPLETE', 2, 1])
    equal((await inspector.get(packedIdbStores.contents, descriptor.content)).refs, 2)
    const receiptHash = await sha(JSON.stringify(complete)),
      read = await journal.readOriginal(receiptHash, 'provenTxs', 0),
      readAllowance = f.workingAllocation.claim(4096 + 4 * bytes.length + 12 * 65536),
      reconstructed = new Uint8Array(bytes.length)
    try {
      equal(
        [read.payload, read.bytes, read.sha256],
        [f.original, new TextEncoder().encode(f.original).length, await sha(f.original)]
      )
      equal(read.fields, { rawTx: descriptor })
      for (let offset = 0; offset < bytes.length; offset += 65536) {
        const chunk = await journal.readOriginalExtent(
          receiptHash,
          'provenTxs',
          0,
          'rawTx',
          offset,
          Math.min(65536, bytes.length - offset)
        )
        try {
          reconstructed.set(chunk, offset)
        } finally {
          chunk.fill(0)
        }
      }
      for (let index = 0; index < bytes.length; index++)
        if (reconstructed[index] !== bytes[index])
          throw new Error('Current original extent differs from independent native content oracle')
      await rejects(async () => journal.readOriginal(await sha(JSON.stringify(header)), 'provenTxs', 0))
      await rejects(() => journal.readOriginalExtent(receiptHash, 'provenTxs', 0, 'rawTx', 0, 65537))
    } finally {
      reconstructed.fill(0)
      readAllowance.close()
      read.close()
    }
    equal(f.workingAllocation.used, 0)
    await stage.close()
    await f.storage.collectPackedStorage(16, 16)
    equal((await inspector.get(packedIdbStores.contents, descriptor.content)).refs, 2)
    let applied = false
    equal(
      await journal.commit(f.rowStep, complete.destinationSha256, async () => {
        applied = true
        throw new Error('Lost ACK must not reapply')
      }),
      complete
    )
    equal(applied, false)
    equal(f.workingAllocation.used, 0)
  } finally {
    await stage.close()
    await journal.close()
    inspector.close()
    await f.storage.destroy()
    await deleteDB(f.storage.dbName)
  }
}

export async function verifyIdbExpiredOriginalRetirementIsBoundedAndRestartable(): Promise<void> {
  const f = await fixture(4194304),
    admission = { ...f.admission, totalRows: 3 },
    journal = await Brc38IdbImportJournal.open(f.owner, admission, f.options),
    inspector = await openDB(f.storage.dbName, 7),
    bytes = Uint8Array.from({ length: 98304 }, (_, index) => index % 251),
    nativeHash = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))),
    sha256 = Array.from(nativeHash, byte => byte.toString(16).padStart(2, '0')).join(''),
    stage = await f.storage.beginPackedStorageField({
      kind: 'array',
      bytes: bytes.length,
      sha256,
      expiresAt: admission.expiresAt
    })
  let cleanup: Brc38IdbImportJournal | undefined
  const actualNow = Date.now
  try {
    await stage.append(0, bytes.subarray(0, 65536))
    await stage.append(65536, bytes.subarray(65536))
    await stage.finish()
    const descriptor = stage.descriptor,
      prepared = await journal.prepare(admission.initialDestinationSha256),
      header = await journal.commit(f.headerStep, prepared.destinationSha256, async writer => {
        await writer.transaction.objectStore('users').add(f.user)
        await writer.original('header', 0, f.header)
        return f.headerDestination
      }),
      { rawTx: _raw, ...row } = f.row,
      partial = await journal.commit(f.rowStep, header.destinationSha256, async writer => {
        await f.storage.writeStagedStorageRow('proven_txs', row, { rawTx: stage }, 'add', writer.transaction)
        await writer.map('provenTx', -1, 2)
        await writer.originalStreamed('provenTxs', 0, f.original, { rawTx: stage })
        return f.rowDestination
      }),
      before = await inspector.get(packedIdbStores.clock, 'clock')
    equal(partial.state, 'COMMITTED')
    equal((await inspector.get(packedIdbStores.contents, descriptor.content)).refs, 2)
    await rejects(() => Brc38IdbImportJournal.openExpiredCleanup(f.owner, admission, f.options))
    await rejects(() => journal.retireExpiredOriginals(1))
    await journal.close()
    // Explicit wall-calendar boundary injection in a real browser fixture; this
    // does not claim physical two-minute waiting or worker-kill qualification.
    Date.now = () => admission.expiresAt + 1
    cleanup = await Brc38IdbImportJournal.openExpiredCleanup(f.owner, admission, f.options)
    equal(await cleanup.retireExpiredOriginals(1), { retired: 1, remaining: 1 })
    await cleanup.close()
    cleanup = await Brc38IdbImportJournal.openExpiredCleanup(f.owner, admission, f.options)
    equal(await cleanup.retireExpiredOriginals(1), { retired: 1, remaining: 0 })
    // A lost acknowledgement/reopened actor uses actual remaining counts.
    equal(await cleanup.retireExpiredOriginals(1), { retired: 0, remaining: 0 })
    const after = await inspector.get(packedIdbStores.clock, 'clock'),
      entry = await inspector.get(idbImportJournalStores.journal, 1)
    equal([after.epoch, after.revision], [before.epoch, before.revision])
    equal(JSON.parse(entry.receiptJson).state, 'EXPIRED')
    equal([entry.originalRows, entry.originalBytes], [0, 0])
    equal(await inspector.count(idbImportJournalStores.originals), 0)
    equal(await inspector.count('proven_txs'), 1)
    equal(await inspector.count(idbImportJournalStores.ids), 1)
    equal((await inspector.get(packedIdbStores.contents, descriptor.content)).refs, 1)
    await rejects(() => cleanup!.read())
    equal(f.workingAllocation.used, 0)
    Date.now = actualNow
    await stage.close()
    await f.storage.collectPackedStorage(16, 16)
    equal((await inspector.get(packedIdbStores.contents, descriptor.content)).refs, 1)
  } finally {
    Date.now = actualNow
    await cleanup?.close()
    await stage.close()
    await journal.close()
    inspector.close()
    await f.storage.destroy()
    await deleteDB(f.storage.dbName)
  }
}

export async function verifyPackedBrowserSnapshotSourceNegotiationAndReplicaCursorContract(): Promise<void> {
  const f = await fixture(4194304),
    journal = await Brc38IdbImportJournal.open(f.owner, f.admission, f.options),
    inspector = await openDB(f.storage.dbName, 7),
    legacy = new StorageIdb(StorageProvider.createStorageBaseOptions('test'))
  let source: Awaited<ReturnType<NonNullable<ReturnType<StorageIdb['getSnapshotSync']>>['openSource']>>
  try {
    equal(legacy.getSnapshotSync(), undefined)
    const prepared = await journal.prepare(f.admission.initialDestinationSha256)
    await journal.commit(f.headerStep, prepared.destinationSha256, async writer => {
      await writer.transaction.objectStore('users').add(f.user)
      await writer.original('header', 0, f.header)
      return f.headerDestination
    })
    // Explicit genuine row-effect fixture with unrelated native rows on both
    // sides of the selected profile. This grants no archive/activation verdict.
    const effects = f.owner.restoreTransaction(['output_baskets'], 'readwrite'),
      native = effects.wallet
    try {
      for (const basketId of [1, 2, 3])
        await native.objectStore('output_baskets').add({
          basketId,
          userId: basketId === 2 ? 1 : 99,
          name: 'fixture-' + basketId,
          isDeleted: false,
          numberOfDesiredUTXOs: 0,
          minimumDesiredUTXOValue: 0,
          created_at: new Date('2026-01-01'),
          updated_at: new Date('2026-01-01')
        })
      await f.owner.sealRestoreEffects(native)
      await effects.journal.done
    } catch (cause) {
      f.owner.abandonRestoreEffects(native)
      await effects.journal.done.catch(() => undefined)
      throw cause
    }
    const capability = f.storage.getSnapshotSync()
    if (capability === undefined) throw new Error('Packed snapshot source was not negotiated')
    equal(await capability.supportsDestination(), false)
    source = await capability.openSource(f.user.identityKey, { lifetimeMs: 10000 })
    if (source === undefined || !/^[0-9a-f]{64}$/.test(source.snapshotId))
      throw new Error('Replica snapshot source ID contract differs')
    equal(await inspector.count(packedIdbStores.leases), 1)
    for (const [tableIndex, table] of snapshotSyncTables.entries()) {
      const page = await source.readPage(table, undefined, { maxRows: 1000, maxBytes: 1048576 }),
        checkpoint: SnapshotSyncCheckpoint = {
          version: 1,
          sessionId: 'a'.repeat(64),
          snapshotId: source.snapshotId,
          identityKey: f.user.identityKey,
          sourceStorageIdentityKey: f.options.profile.targetStorageIdentityKey,
          destinationStorageIdentityKey: 'different-replica',
          tableIndex,
          sequence: tableIndex,
          done: false
        }
      if (table === 'outputBaskets') {
        equal([page.rows.length, page.done, page.cursor?.after], [1, true, [2]])
        equal(await source.readPage(table, undefined, { maxRows: 1000, maxBytes: 1048576 }), page)
        const tail = await source.readPage(table, page.cursor, { maxRows: 1000, maxBytes: 1048576 })
        equal([tail.rows.length, tail.done, tail.cursor?.after], [0, true, [2]])
      } else equal([page.rows.length, page.done, page.cursor], [0, true, undefined])
      equal(detachSnapshotSyncPage(checkpoint, page).nextTable, tableIndex + 1)
    }
    await rejects(() => source!.readPage('syncStates'))
    await rejects(() =>
      source!.readPage('outputs', { version: 1, snapshotId: 'f'.repeat(64), table: 'outputs', after: [1] })
    )
    await source.close()
    await source.closed
    equal(await inspector.count(packedIdbStores.leases), 0)
    await rejects(() => source!.readPage('outputs'))
  } finally {
    await source?.close()
    await journal.close()
    inspector.close()
    await f.storage.destroy()
    await deleteDB(f.storage.dbName)
  }
}

export async function verifyExpiredBrowserNamespaceRetirementRequiresOriginalScopeAndNativeState(): Promise<void> {
  const f = await fixture(4194304),
    admission = { ...f.admission, totalRows: 3 },
    journal = await Brc38IdbImportJournal.open(f.owner, admission, f.options),
    inspector = await openDB(f.storage.dbName, 7),
    actualNow = Date.now,
    retire = (input = admission) =>
      retireExpiredBrc38BrowserProfile({
        databaseName: f.storage.dbName,
        admission: input,
        journal: f.options,
        expiresAt: Date.now() + 10000
      })
  let inspectorClosed = false
  try {
    const prepared = await journal.prepare(admission.initialDestinationSha256)
    await journal.commit(f.headerStep, prepared.destinationSha256, async writer => {
      await writer.transaction.objectStore('users').add(f.user)
      await writer.original('header', 0, f.header)
      return f.headerDestination
    })
    await journal.close()
    const before = await inspector.get(packedIdbStores.clock, 'clock'),
      entry = await inspector.get(idbImportJournalStores.journal, 1)
    await rejects(() => retire())
    Date.now = () => admission.expiresAt + 1
    await rejects(() => retire({ ...admission, scope: { ...admission.scope, bindingSha256: 'f'.repeat(64) } }))
    // Raw Native corruption fixtures are not enrolled provider effects.
    await inspector.put('users', { ...f.user, activeStorage: f.options.profile.targetStorageIdentityKey })
    await rejects(() => retire())
    await inspector.put('users', f.user)
    await inspector.put('monitor_events', { id: 998, event: 'foreign-runtime-fixture' })
    await rejects(() => retire())
    await inspector.delete('monitor_events', 998)
    await inspector.put(packedIdbStores.leases, { id: 'retirement-live-lease-fixture', expiresAt: Date.now() + 1000 })
    await rejects(() => retire())
    await inspector.delete(packedIdbStores.leases, 'retirement-live-lease-fixture')
    equal(await inspector.get(packedIdbStores.clock, 'clock'), before)
    equal(await inspector.get(idbImportJournalStores.journal, 1), entry)
    equal(f.workingAllocation.used, 0)
    inspector.close()
    inspectorClosed = true
    await f.storage.destroy()
    const retired = await retire()
    equal(
      [retired.databaseName, retired.importId, retired.epoch, retired.revision, retired.deletedOriginalNamespace],
      [f.storage.dbName, admission.scope.importId, before.epoch, before.revision, true]
    )
    equal(f.workingAllocation.used, 0)
    await requireNamespaceAbsent(f.storage.dbName)
    // A lost deletion ACK does not permit creating or deleting a fresh profile.
    await rejects(() => retire())
    await requireNamespaceAbsent(f.storage.dbName)
    equal(f.workingAllocation.used, 0)
  } finally {
    Date.now = actualNow
    await journal.close()
    if (!inspectorClosed) inspector.close()
    await f.storage.destroy()
    await deleteDB(f.storage.dbName)
  }
}

export async function verifyBrowserNamespaceRetirementNeverDeletesCompleteCandidates(): Promise<void> {
  const f = await fixture(4194304),
    journal = await Brc38IdbImportJournal.open(f.owner, f.admission, f.options),
    inspector = await openDB(f.storage.dbName, 7),
    actualNow = Date.now
  try {
    const prepared = await journal.prepare(f.admission.initialDestinationSha256),
      header = await journal.commit(f.headerStep, prepared.destinationSha256, async writer => {
        await writer.transaction.objectStore('users').add(f.user)
        await writer.original('header', 0, f.header)
        return f.headerDestination
      })
    await journal.commit(f.rowStep, header.destinationSha256, async writer => {
      await writer.transaction.objectStore('proven_txs').add(f.row)
      await writer.map('provenTx', -1, 2)
      await writer.original('provenTxs', 0, f.original)
      return f.rowDestination
    })
    await journal.close()
    const before = await inspector.get(packedIdbStores.clock, 'clock'),
      entry = await inspector.get(idbImportJournalStores.journal, 1)
    Date.now = () => f.admission.expiresAt + 1
    await rejects(() =>
      retireExpiredBrc38BrowserProfile({
        databaseName: f.storage.dbName,
        admission: f.admission,
        journal: f.options,
        expiresAt: Date.now() + 10000
      })
    )
    equal(await inspector.get(packedIdbStores.clock, 'clock'), before)
    equal(await inspector.get(idbImportJournalStores.journal, 1), entry)
    equal(await inspector.count('proven_txs'), 1)
    equal(f.workingAllocation.used, 0)
  } finally {
    Date.now = actualNow
    await journal.close()
    inspector.close()
    await f.storage.destroy()
    await deleteDB(f.storage.dbName)
  }
}

export async function verifyIdbExpiredCleanupPreservesCompleteAndActivatedProfiles(): Promise<void> {
  const f = await fixture(),
    journal = await Brc38IdbImportJournal.open(f.owner, f.admission, f.options),
    inspector = await openDB(f.storage.dbName, 7),
    actualNow = Date.now
  try {
    const prepared = await journal.prepare(f.admission.initialDestinationSha256),
      header = await journal.commit(f.headerStep, prepared.destinationSha256, async writer => {
        await writer.transaction.objectStore('users').add(f.user)
        await writer.original('header', 0, f.header)
        return f.headerDestination
      })
    await journal.commit(f.rowStep, header.destinationSha256, async writer => {
      await writer.transaction.objectStore('proven_txs').add(f.row)
      await writer.map('provenTx', -1, 2)
      await writer.original('provenTxs', 0, f.original)
      return f.rowDestination
    })
    const before = await inspector.get(idbImportJournalStores.journal, 1)
    Date.now = () => f.admission.expiresAt + 1
    await rejects(() => Brc38IdbImportJournal.openExpiredCleanup(f.owner, f.admission, f.options))
    await rejects(() => journal.retireExpiredOriginals(1))
    equal(await inspector.get(idbImportJournalStores.journal, 1), before)
    equal(await inspector.count(idbImportJournalStores.originals), 2)
    Date.now = actualNow
    const claimedPrimary = { ...f.user, activeStorage: f.options.profile.targetStorageIdentityKey }
    await rejects(() => f.storage.db!.put('users', claimedPrimary))
    // A current primary claim must protect the namespace even when introduced
    // by another enrolled restore writer. This fixture is a refusal oracle;
    // complete authenticated publication/activation is covered separately.
    const changed = f.owner.restoreTransaction(['users'], 'readwrite')
    try {
      await changed.wallet.objectStore('users').put(claimedPrimary)
      await f.owner.sealRestoreEffects(changed.wallet)
      await changed.journal.done
    } catch (cause) {
      f.owner.abandonRestoreEffects(changed.wallet)
      await changed.journal.done.catch(() => undefined)
      throw cause
    }
    equal((await inspector.get('users', f.user.userId)).activeStorage, claimedPrimary.activeStorage)
    Date.now = () => f.admission.expiresAt + 1
    await rejects(() => Brc38IdbImportJournal.openExpiredCleanup(f.owner, f.admission, f.options))
    equal(await inspector.count(idbImportJournalStores.originals), 2)
    equal(f.workingAllocation.used, 0)
  } finally {
    Date.now = actualNow
    await journal.close()
    inspector.close()
    await f.storage.destroy()
    await deleteDB(f.storage.dbName)
  }
}

export async function verifyIdbGlobalReferenceMultiplicityQuotaAndOrphanRefusal(): Promise<void> {
  const f = await fixture(4194304),
    inspector = await openDB(f.storage.dbName, 7),
    journal = await Brc38IdbImportJournal.open(f.owner, f.admission, f.options),
    bytes = new Uint8Array(64)
  for (let at = 0; at < bytes.length; at++) bytes[at] = (at * 37 + 11) & 255
  const digestBytes = async (value: Uint8Array) =>
      Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(value))), byte =>
        byte.toString(16).padStart(2, '0')
      ).join(''),
    sha256 = await digestBytes(bytes),
    stage = await f.storage.beginPackedStorageField({
      kind: 'array',
      bytes: bytes.length,
      sha256,
      lifetimeMs: 120000,
      expiresAt: f.admission.expiresAt
    })
  try {
    await stage.append(0, bytes)
    const descriptor = await stage.finish(),
      prepared = await journal.prepare(f.admission.initialDestinationSha256),
      header = await journal.commit(f.headerStep, prepared.destinationSha256, async writer => {
        await writer.transaction.objectStore('users').add(f.user)
        await writer.original('header', 0, f.header, f.user.userId)
        return f.headerDestination
      }),
      { rawTx: _raw, merklePath: _merkle, ...metadata } = f.row,
      complete = await journal.commit(f.rowStep, header.destinationSha256, async writer => {
        const key = await f.storage.writeStagedStorageRow(
          'proven_txs',
          metadata,
          { rawTx: stage, merklePath: stage },
          'add',
          writer.transaction
        )
        await writer.map('provenTx', -1, Number(key))
        await writer.originalStreamed('provenTxs', 0, f.original, { rawTx: stage, merklePath: stage }, key)
        return f.rowDestination
      })
    await stage.close()
    const range = IDBKeyRange.bound([descriptor.content, 0], [descriptor.content, 127])
    equal(await inspector.countFromIndex(packedIdbStores.versions, 'references', range), 2)
    equal(await inspector.countFromIndex(idbImportJournalStores.originals, 'references', range), 2)
    equal((await inspector.get(packedIdbStores.contents, descriptor.content)).refs, 4)
    const inventory = await inspectBrc38IdbPackedReferenceInventory(journal, complete),
      receiptSha = await sha(JSON.stringify(complete))
    equal([inventory.references, inventory.contents, inventory.chunks], [4, 1, 1])
    equal(f.workingAllocation.used, 0)
    const destination = await journal.readDestination(receiptSha, 'provenTxs', 0)
    try {
      equal(destination.key, f.row.provenTxId)
      equal(destination.extents.rawTx.content, destination.extents.merklePath.content)
    } finally {
      destination.close()
    }
    equal(
      Array.from(await journal.readDestinationExtent(receiptSha, 'provenTxs', 0, 'rawTx', 0, bytes.length)),
      Array.from(bytes)
    )
    const head = await inspector.get(packedIdbStores.heads, ['proven_txs', f.row.provenTxId]),
      version = await inspector.get(packedIdbStores.versions, ['proven_txs', f.row.provenTxId, head.revision]),
      clock = await inspector.get(packedIdbStores.clock, 'clock'),
      content = await inspector.get(packedIdbStores.contents, descriptor.content),
      originalChunk = await inspector.get(packedIdbStores.chunks, [descriptor.content, 0])
    // Explicit raw native corruption oracles. Each is restored immediately;
    // no failed content/ref/charge is accepted, skipped or collected as valid.
    await inspector.put(packedIdbStores.versions, { ...version, references: [[descriptor.content, 0]] })
    await rejects(() => inspectBrc38IdbPackedReferenceInventory(journal, complete))
    await inspector.put(packedIdbStores.versions, version)
    await inspector.put(packedIdbStores.contents, { ...content, refs: 5 })
    await rejects(() => inspectBrc38IdbPackedReferenceInventory(journal, complete))
    await inspector.put(packedIdbStores.contents, content)
    await inspector.put(packedIdbStores.clock, { ...clock, bytes: clock.bytes + 1 }, 'clock')
    await rejects(() => inspectBrc38IdbPackedReferenceInventory(journal, complete))
    await inspector.put(packedIdbStores.clock, clock, 'clock')
    const orphan = 'f'.repeat(32)
    if (orphan === descriptor.content) throw new Error('Synthetic orphan collided with genuine content')
    await inspector.add(packedIdbStores.chunks, { content: orphan, index: 0, data: bytes, sha256 })
    await rejects(() => inspectBrc38IdbPackedReferenceInventory(journal, complete))
    await inspector.delete(packedIdbStores.chunks, [orphan, 0])
    const changed = bytes.slice()
    changed[0] ^= 1
    await inspector.put(packedIdbStores.chunks, { ...originalChunk, data: changed, sha256: await digestBytes(changed) })
    await rejects(() => inspectBrc38IdbPackedReferenceInventory(journal, complete))
    await inspector.put(packedIdbStores.chunks, originalChunk)
    equal(await inspectBrc38IdbPackedReferenceInventory(journal, complete), inventory)
    equal(f.workingAllocation.used, 0)
  } finally {
    await stage.close()
    await journal.close()
    inspector.close()
    await f.storage.destroy()
    await deleteDB(f.storage.dbName)
  }
}
