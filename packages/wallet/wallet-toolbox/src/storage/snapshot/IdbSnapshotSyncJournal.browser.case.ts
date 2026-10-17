import { deleteDB } from 'idb'
import { StorageIdb } from '../StorageIdb'
import { StorageProvider } from '../StorageProvider'
import { getPackedIdbConnection } from '../idbPackedConnection'
import { packedIdbStores, readPackedIdbClock } from '../idbPackedFields'
import { IdbSnapshotSyncJournal, type IdbSnapshotSyncRead } from './IdbSnapshotSyncJournal'
import type { SnapshotSyncSource } from './SnapshotSync'
import type { SyncChunk } from '../../sdk/WalletStorage.interfaces'
import { createSyncMap } from '../schema/entities/EntityBase'
import type { Chain } from '../../sdk/types'

function same(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Independent packed journal oracle differs')
}
async function refused(action: () => Promise<unknown>): Promise<void> {
  let error = false
  try {
    await action()
  } catch {
    error = true
  }
  if (!error) throw new Error('Packed journal admitted a stale or escaped effect')
}
/** Authored UNRUN contract case over actual browser transactions. Synthetic
 * prepared effects deliberately test atomicity/custody, not source/archive
 * authentication, entity semantics, primary promotion or production readiness. */
export async function verifyOccupiedPackedIdbSnapshotJournal(expiresAt: number, chain: Chain = 'test'): Promise<void> {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 120000)
    throw new Error('Original finite journal case deadline is required')
  const deadline = performance.now() + expiresAt - Date.now(),
    check = () => {
      if (Date.now() >= expiresAt || performance.now() >= deadline)
        throw new Error('Original journal case deadline ended')
    },
    storage = new StorageIdb({
      ...StorageProvider.createStorageBaseOptions(chain),
      packed: {
        maximumLogicalBytes: 16777216,
        maximumRecords: 10000
      }
    }),
    identityKey = '02' + '11'.repeat(32),
    unrelatedIdentity = '03' + '22'.repeat(32),
    dates = { created_at: new Date('2026-01-01'), updated_at: new Date('2026-01-01') },
    local = { ...dates, userId: 1, identityKey, activeStorage: 'target' },
    unrelated = { ...dates, userId: 2, identityKey: unrelatedIdentity, activeStorage: 'target' },
    original = {
      ...dates,
      userId: 1,
      basketId: 3,
      name: 'existing',
      isDeleted: false,
      numberOfDesiredUTXOs: 0,
      minimumDesiredUTXOValue: 0
    }
  storage.dbName = 'packed-occupied-journal-' + crypto.randomUUID()
  try {
    check()
    await storage.migrate('Independent occupied journal fixture', 'target')
    await storage.db!.put('users', local)
    await storage.db!.put('users', unrelated)
    await storage.db!.put('output_baskets', original)
    const source: SnapshotSyncSource = {
      version: 1,
      snapshotId: 'aa'.repeat(32),
      expiresAt,
      sourceStorage: { ...(await storage.readSettings()), storageIdentityKey: 'source' },
      user: { ...local, userId: 77, activeStorage: 'source' }
    }
    let journal = await IdbSnapshotSyncJournal.open(storage),
      cp = await journal.begin(source, 'source')
    same(await journal.begin(source, 'source'), cp)
    cp = (await journal.commit(cp, 1, null, async () => ({ inserts: 0, updates: 0 }))).checkpoint
    const chunk: SyncChunk = {
      fromStorageIdentityKey: 'source',
      toStorageIdentityKey: 'target',
      userIdentityKey: identityKey,
      outputBaskets: [{ ...original, userId: 77, basketId: 21, numberOfDesiredUTXOs: 7 }]
    }
    const before = await journal.checkpoint(identityKey, 'source'),
      owner = getPackedIdbConnection(storage.db!)!,
      readClock = async () => {
        const tx = owner.rawTransaction([], 'readonly')
        const clock = await readPackedIdbClock(tx)
        await tx.done
        return clock
      },
      beforeClock = await readClock()
    let escaped: Readonly<IdbSnapshotSyncRead> | undefined
    await journal.inspect(cp, async read => {
      escaped = read
      same(read.transaction.mode, 'readonly')
      same(read.user.userId, 1)
      same(read.sourceUserId, 77)
      same(read.expiresAt, expiresAt)
      const mappings = await read.loadMappings('outputBaskets', chunk)
      same(mappings.outputBasket.idMap[21], undefined)
      same(
        (await read.findCurrentRow({ table: 'outputBaskets', name: 'existing' }, mappings, 65536))?.fields
          .numberOfDesiredUTXOs,
        0
      )
      await refused(async () => {
        const store = read.transaction.objectStore('output_baskets'),
          put: unknown = Reflect.get(store, 'put')
        if (typeof put !== 'function') throw new Error('Read-only facade exposes no writer')
        await Reflect.apply(put, store, [original])
      })
    })
    await refused(() => escaped!.loadMappings('outputBaskets', chunk))
    await refused(() => escaped!.findCurrentRow({ table: 'outputBaskets', name: 'existing' }, createSyncMap(), 65536))
    same(await readClock(), beforeClock)
    await refused(() =>
      journal.commit(cp, 2, null, async writer => {
        const mappings = await writer.loadMappings('outputBaskets', chunk)
        same(
          (await writer.findCurrentRow({ table: 'outputBaskets', name: 'existing' }, mappings.map, 65536))?.fields
            .numberOfDesiredUTXOs,
          0
        )
        mappings.map.outputBasket.idMap[21] = 3
        await writer.transaction.objectStore('output_baskets').put({ ...original, numberOfDesiredUTXOs: 7 })
        await mappings.persist()
        throw new Error('Independent forced interruption before checkpoint')
      })
    )
    same(await journal.checkpoint(identityKey, 'source'), before)
    same(await storage.db!.get('output_baskets', 3), original)
    same(await readClock(), beforeClock)
    const outcome = await journal.commit(cp, 2, null, async writer => {
      const mappings = await writer.loadMappings('outputBaskets', chunk)
      same(
        (await writer.findCurrentRow({ table: 'outputBaskets', name: 'existing' }, mappings.map, 65536))?.fields
          .numberOfDesiredUTXOs,
        0
      )
      same(mappings.map.outputBasket.idMap[21], undefined)
      mappings.map.outputBasket.idMap[21] = 3
      await writer.transaction.objectStore('output_baskets').put({ ...original, numberOfDesiredUTXOs: 7 })
      await mappings.persist()
      return { inserts: 0, updates: 1 }
    })
    same(outcome.checkpoint.sequence, 2)
    same(outcome.updates, 1)
    // Actual reopen observes committed progress after an acknowledgement loss.
    await storage.destroy()
    journal = await IdbSnapshotSyncJournal.open(storage)
    same(await journal.checkpoint(identityKey, 'source'), outcome.checkpoint)
    let invoked = false
    await refused(() =>
      journal.commit(cp, 2, null, async () => {
        invoked = true
        return { inserts: 0, updates: 0 }
      })
    )
    await refused(() =>
      journal.inspect(cp, async () => {
        invoked = true
      })
    )
    same(invoked, false)
    same(await storage.db!.get('users', 2), unrelated)
    const freshOwner = getPackedIdbConnection(storage.db!)!,
      inspect = freshOwner.rawTransaction([], 'readonly')
    same(
      await inspect
        .objectStore(packedIdbStores.syncIds)
        .get([1, 'source', outcome.checkpoint.sessionId, 'outputBasket', 21]),
      {
        userId: 1,
        sourceStorageIdentityKey: 'source',
        sessionId: outcome.checkpoint.sessionId,
        expiresAt,
        entity: 'outputBasket',
        incomingId: 21,
        localId: 3
      }
    )
    same(
      await inspect
        .objectStore(packedIdbStores.syncIds)
        .get([2, 'source', outcome.checkpoint.sessionId, 'outputBasket', 21]),
      undefined
    )
    await inspect.done
    // Same incoming ID on another source has an independent mapping namespace.
    const otherSource = {
        ...source,
        snapshotId: 'bb'.repeat(32),
        sourceStorage: { ...source.sourceStorage, storageIdentityKey: 'second-source' }
      },
      other = await journal.begin(otherSource, 'source')
    same(other.sequence, 0)
    same(await journal.checkpoint(identityKey, 'source'), outcome.checkpoint)
    // A primary away/back change remains visible through its real user head.
    await storage.db!.put('users', { ...local, activeStorage: 'away' })
    await storage.db!.put('users', local)
    same(await journal.checkpoint(identityKey, 'source'), outcome.checkpoint)
    await refused(() => journal.begin(source, 'source'))
    await refused(() =>
      journal.inspect(outcome.checkpoint, async () => {
        invoked = true
      })
    )
    same(invoked, false)
    await refused(() => journal.commit(outcome.checkpoint, 3, null, async () => ({ inserts: 0, updates: 0 })))
    check()
  } finally {
    try {
      await storage.destroy()
    } finally {
      await deleteDB(storage.dbName)
    }
  }
}
