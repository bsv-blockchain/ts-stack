import { runInSeries } from '../../utility/runInSeries'
import { deleteDB } from 'idb'
import { StorageIdb } from '../StorageIdb'
import { StorageProvider } from '../StorageProvider'
import { WalletStorageManager } from '../WalletStorageManager'
import { runSnapshotSyncSession } from './runSnapshotSyncSession'
import { IdbSnapshotSyncJournal } from './IdbSnapshotSyncJournal'
import { getPackedIdbConnection } from '../idbPackedConnection'
import { packedIdbStores } from '../idbPackedFields'
import { snapshotSyncContentPosition } from './SnapshotSyncContentRevision'
import { closeSnapshotJournalSource } from './journal/closeSnapshotJournalSource'
import type { WalletReadSnapshot } from './WalletReadSnapshot'

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error('Packed content receipt oracle: ' + message)
}
function same(actual: unknown, expected: unknown): void {
  requireValue(JSON.stringify(actual) === JSON.stringify(expected), 'independent postimage differs')
}

/** Browser-native contract case; the Node test supplies emulated IndexedDB
 * only for edit feedback. A fresh original browser controller owns physical
 * qualification. Every source and database drains in this case's finally. */
export async function verifyPackedIdbSnapshotContentReceipts(expiresAt: number): Promise<void> {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 120000)
    throw new Error('Original finite content receipt case deadline is required')
  const deadline = performance.now() + expiresAt - Date.now(),
    providers: StorageIdb[] = [],
    views: WalletReadSnapshot[] = []
  const check = () => requireValue(Date.now() < expiresAt && performance.now() < deadline, 'original deadline ended')
  const identityKey = '02' + '11'.repeat(32),
    when = new Date('2026-01-01T00:00:00Z')
  const open = async (identity: string) => {
    check()
    const storage = new StorageIdb({
      ...StorageProvider.createStorageBaseOptions('test'),
      packed: { maximumLogicalBytes: 16777216, maximumRecords: 10000 }
    })
    providers.push(storage)
    storage.dbName = 'packed-content-receipt-' + crypto.randomUUID()
    await storage.migrate('Independent content receipt fixture', identity)
    await storage.makeAvailable()
    return storage
  }
  let failure: { error: unknown } | undefined
  try {
    const source = await open('source'),
      destination = await open('destination')
    const { user } = await source.findOrInsertUser(identityKey)
    await source.updateUser(user.userId, { activeStorage: 'source' })
    const basketId = await source.insertOutputBasket({
      basketId: 0,
      userId: user.userId,
      name: 'content basket',
      isDeleted: false,
      numberOfDesiredUTXOs: 7,
      minimumDesiredUTXOValue: 41,
      created_at: when,
      updated_at: when
    })
    const manager = new WalletStorageManager(identityKey, source)
    const first = await manager.syncToWriterResumable({ identityKey }, destination, { maxItems: 1 })
    requireValue(
      first.status === 'completed' && first.snapshotCheckpoint?.done && first.noChangeReceipt === undefined,
      'first copy did not complete normally'
    )
    const cap = destination.getSnapshotSync()!,
      previous = await cap.previousContentReceipt!(identityKey, 'source')
    same(previous?.checkpoint, first.snapshotCheckpoint)
    requireValue(previous !== undefined, 'atomic completion DATA is missing')
    let futureRefused = false
    try {
      await source.getSnapshotSync()!.observeContentRevision!(identityKey, {
        ...snapshotSyncContentPosition(previous.source),
        highWater: String(Number(previous.source.highWater) + 1)
      })
    } catch {
      futureRefused = true
    }
    requireValue(futureRefused, 'future DATA position was accepted')
    const second = await manager.syncToWriterResumable({ identityKey }, destination, { maxItems: 1 })
    requireValue(
      second.pages === 0 && second.inserts === 0 && second.updates === 0 && second.snapshotCheckpoint === undefined,
      'unchanged copy materialized another view'
    )
    same(second.noChangeReceipt?.checkpoint, first.snapshotCheckpoint)
    await destination.destroy()
    const journal = await IdbSnapshotSyncJournal.open(destination)
    same((await journal.previousContentReceipt(identityKey, 'source'))?.checkpoint, first.snapshotCheckpoint)
    const reopened = await manager.syncToWriterResumable({ identityKey }, destination)
    same(reopened.noChangeReceipt?.checkpoint, first.snapshotCheckpoint)
    check()
    await source.updateOutputBasket(basketId, { numberOfDesiredUTXOs: 9, updated_at: new Date('2026-01-02T00:00:00Z') })
    const changed = await manager.syncToWriterResumable({ identityKey }, destination, { maxItems: 1 })
    requireValue(
      changed.snapshotCheckpoint?.done && changed.noChangeReceipt === undefined,
      'source change reused a stale receipt'
    )
    const copied = (await destination.findOutputBaskets({ partial: { name: 'content basket' } }))[0]
    requireValue(
      copied?.numberOfDesiredUTXOs === 9 && copied.minimumDesiredUTXOValue === 41,
      'changed source data was not copied'
    )
    const current = await destination.getSnapshotSync()!.previousContentReceipt!(identityKey, 'source')
    requireValue(current !== undefined, 'replacement copy lacks completion DATA')
    await destination.updateOutputBasket(copied.basketId, {
      numberOfDesiredUTXOs: 11,
      updated_at: new Date('2026-01-03T00:00:00Z')
    })
    const observation = await source.getSnapshotSync()!.observeContentRevision!(
      identityKey,
      snapshotSyncContentPosition(current.source)
    )
    requireValue(observation !== undefined, 'actual source observation unavailable')
    requireValue(
      (await destination.getSnapshotSync()!.confirmContentReceipt!(identityKey, 'source', observation)) === undefined,
      'destination edit reused stale completion DATA'
    )
    const destinationUser = (await destination.findUserByIdentityKey(identityKey))!
    await destination.updateUser(destinationUser.userId, { activeStorage: 'destination' })
    requireValue(
      (await destination.getSnapshotSync()!.previousContentReceipt!(identityKey, 'source')) === undefined,
      'primary change did not invalidate comparison DATA'
    )
    check()
    const legacy = await open('legacy-destination'),
      legacyCap = legacy.getSnapshotSync()!,
      sourceCap = source.getSnapshotSync()!
    const view = await sourceCap.openSource(identityKey)
    requireValue(view !== undefined && view.readContentRevision !== undefined, 'actual retained source missing')
    views.push(view)
    const revision = await view.readContentRevision()
    const old = await runSnapshotSyncSession(
      {
        view,
        destination: { ...legacyCap, supportsContentDestination: undefined, beginContent: undefined },
        activeStorage: 'source',
        commit: async operation => await operation()
      },
      {}
    )
    requireValue(old.snapshotCheckpoint?.done, 'legacy copy did not complete')
    let refused = false
    try {
      await legacyCap.beginContent!(view, 'source', revision)
    } catch {
      refused = true
    }
    requireValue(refused, 'completed legacy ACK acquired a retroactive comparison stamp')
    const legacyUser = (await legacy.findUserByIdentityKey(identityKey))!
    const owner = getPackedIdbConnection(legacy.db!)!,
      raw = owner.rawTransaction([], 'readonly')
    const session = await raw.objectStore(packedIdbStores.syncSessions).get([legacyUser.userId, 'source'])
    await raw.done
    requireValue(
      session !== undefined && !Object.hasOwn(session, 'content'),
      'legacy session was modified after refusal'
    )
    await closeSnapshotJournalSource(view)
    check()
  } catch (error) {
    failure = { error }
  }
  const failures: unknown[] = []
  await runInSeries(views, async view => {
    try {
      await closeSnapshotJournalSource(view)
    } catch (error) {
      failures.push(error)
    }
  })
  await runInSeries(providers, async provider => {
    try {
      await provider.destroy()
      await deleteDB(provider.dbName)
    } catch (error) {
      failures.push(error)
    }
  })
  if (failures.length)
    throw new AggregateError(
      [...(failure === undefined ? [] : [failure.error]), ...failures],
      'Packed content receipt case retains original failure and physical cleanup',
      { cause: failure?.error }
    )
  if (failure !== undefined) throw failure.error
}
