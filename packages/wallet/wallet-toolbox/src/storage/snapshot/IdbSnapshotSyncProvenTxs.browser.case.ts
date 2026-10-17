import { deleteDB } from 'idb'
import { MerklePath, Script, Transaction, UnlockingScript } from '@bsv/sdk'
import type { WalletServices } from '../../sdk/WalletServices.interfaces'
import { StorageIdb } from '../StorageIdb'
import { StorageProvider } from '../StorageProvider'
import { IdbSnapshotSyncDestination } from './IdbSnapshotSyncDestination'
import { IdbSnapshotSyncJournal } from './IdbSnapshotSyncJournal'
import { openPackedIdbSyncSource } from './openPackedIdbSyncSource'
import type { WalletReadSnapshot } from './WalletReadSnapshot'
import type { SnapshotSyncFieldPreparation } from './SnapshotSync'

function same(a: unknown, b: unknown): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('Independent occupied proof oracle differs')
}
async function refused(work: () => Promise<unknown>): Promise<void> {
  let failed = false
  try {
    await work()
  } catch {
    failed = true
  }
  if (!failed) throw new Error('Occupied proof accepted stale current data')
}
async function digest(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)))
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
}

/** Authored UNRUN. Actual packed source, staging, current journal and native
 * writer; independent SDK transaction/BUMP and WebCrypto header fixture.
 * The bounded service fixture is a network oracle, not live chain evidence,
 * archive authentication or funded-wallet/production qualification. */
export async function verifyIdbSnapshotSyncProvenTxs(expiresAt: number): Promise<void> {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 120000)
    throw new Error('Original finite proof deadline required')
  const identityKey = '02' + '11'.repeat(32),
    dates = { created_at: new Date('2026-01-01'), updated_at: new Date('2026-01-01') },
    options = {
      ...StorageProvider.createStorageBaseOptions('test'),
      packed: { maximumLogicalBytes: 33554432, maximumRecords: 20000 }
    },
    sourceStorage = new StorageIdb(options),
    target = new StorageIdb(options),
    tx = new Transaction()
  tx.addInput({ sourceTXID: '66'.repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex('51') })
  tx.addOutput({ satoshis: 1, lockingScript: Script.fromHex('6a' + '00'.repeat(70000)) })
  const rawTx = tx.toBinary(),
    txid = tx.id('hex'),
    merklePath = new MerklePath(100, [[{ offset: 0, hash: txid, txid: true }]]).toBinary(),
    header = new Uint8Array(80),
    bytes = Uint8Array.from(txid.match(/../g)!.map(value => parseInt(value, 16)))
  new DataView(header.buffer).setUint32(0, 1, true)
  header.set(bytes.reverse(), 36)
  const blockHash = hex((await digest(await digest(header))).reverse()),
    incoming = { ...dates, txid, height: 100, index: 0, rawTx, merklePath, blockHash, merkleRoot: txid },
    original = {
      ...incoming,
      height: 99,
      merklePath: new MerklePath(99, [[{ offset: 0, hash: txid, txid: true }]]).toBinary(),
      blockHash: '00'.repeat(32)
    }
  sourceStorage.dbName = 'proof-component-source-' + crypto.randomUUID()
  target.dbName = 'proof-component-target-' + crypto.randomUUID()
  let source: WalletReadSnapshot | undefined,
    prepared: SnapshotSyncFieldPreparation | undefined,
    roots = 0,
    headers = 0
  const services = {
    getChainTracker: async () => ({
      isValidRootForHeight: async (root: string, height: number) => {
        roots++
        return root === txid && height === 100
      }
    }),
    getHeaderForHeight: async (height: number) => {
      headers++
      same(height, 100)
      return Array.from(header)
    }
  } as unknown as WalletServices
  target.setServices(services)
  try {
    await sourceStorage.migrate('Independent proof source', 'source')
    await target.migrate('Occupied proof target', 'target')
    await sourceStorage.db!.put('users', { ...dates, userId: 77, identityKey, activeStorage: 'source' })
    await target.db!.put('users', { ...dates, userId: 1, identityKey, activeStorage: 'target' })
    await sourceStorage.db!.put('proven_txs', {
      ...incoming,
      txid: txid.toUpperCase(),
      blockHash: blockHash.toUpperCase(),
      merkleRoot: txid.toUpperCase(),
      provenTxId: 21
    })
    await target.db!.put('proven_txs', { ...original, provenTxId: 3 })
    const transaction = {
      ...dates,
      status: 'completed' as const,
      isOutgoing: false,
      satoshis: 1,
      description: '',
      reference: 'proof',
      txid
    }
    await sourceStorage.db!.put('transactions', { ...transaction, userId: 77, transactionId: 26, provenTxId: 21 })
    await target.db!.put('transactions', { ...transaction, userId: 1, transactionId: 8, provenTxId: 3 })
    source = await openPackedIdbSyncSource(sourceStorage, identityKey, { lifetimeMs: expiresAt - Date.now() })
    const destination = new IdbSnapshotSyncDestination(target, async () => new Map()),
      cp = await destination.begin(
        {
          version: 1,
          snapshotId: source.snapshotId,
          sourceStorage: source.sourceStorage,
          user: source.user,
          expiresAt: source.expiresAt
        },
        'source'
      ),
      page = await source.fieldReader!.readMetadataPage('provenTxs', undefined, { maxRows: 2, maxBytes: 262144 })
    if (page.rows.length !== 1 || page.rows[0].fields.rawTx !== undefined)
      throw new Error('Actual proof source hydrated large raw transaction')
    prepared = await destination.prepareProvenTxs(cp, page, source)
    same([roots, headers], [1, 1])
    const before = await destination.checkpoint(identityKey, 'source')
    await target.db!.put('proven_txs', { ...original, provenTxId: 3, blockHash: 'ff'.repeat(32) })
    await refused(prepared.apply)
    same(await destination.checkpoint(identityKey, 'source'), before)
    await prepared.close()
    prepared = undefined
    prepared = await destination.prepareProvenTxs(cp, page, source)
    const outcome = await prepared.apply()
    same(outcome.inserts, 0)
    same(outcome.updates, 1)
    same(outcome.checkpoint.tableIndex, 1)
    const actual = await target.db!.get('proven_txs', 3)
    same(actual!.txid, txid)
    same(actual!.height, 100)
    same(actual!.blockHash, blockHash)
    same(actual!.merkleRoot, txid)
    same(Array.from(actual!.rawTx), rawTx)
    same(Array.from(actual!.merklePath), merklePath)
    if (actual!.updated_at <= incoming.updated_at) throw new Error('Corrected proof has no discoverable timestamp')
    same([roots, headers], [2, 2])
    await refused(prepared.apply)
    await prepared.close()
    prepared = undefined
    // Reopen an actual source view and compare exact current bytes. The prior
    // session's proof preparation cannot authorize this independent effect.
    await source.close()
    source = await openPackedIdbSyncSource(sourceStorage, identityKey, { lifetimeMs: expiresAt - Date.now() })
    const fresh = await destination.begin(
        {
          version: 1,
          snapshotId: source.snapshotId,
          sourceStorage: source.sourceStorage,
          user: source.user,
          expiresAt: source.expiresAt
        },
        'source'
      ),
      freshPage = await source.fieldReader!.readMetadataPage('provenTxs', undefined, { maxRows: 2, maxBytes: 262144 })
    same(fresh.tableIndex, 0)
    prepared = await destination.prepareProvenTxs(fresh, freshPage, source)
    const equalOutcome = await prepared.apply()
    same(equalOutcome.inserts, 0)
    same(equalOutcome.updates, 0)
    same((await target.db!.get('proven_txs', 3))!.updated_at, actual!.updated_at)
    same([roots, headers], [2, 2])
    await prepared.close()
    prepared = undefined
    const next = await destination.begin(
      {
        version: 1,
        snapshotId: source.snapshotId,
        sourceStorage: source.sourceStorage,
        user: source.user,
        expiresAt: source.expiresAt
      },
      'source'
    )
    if (next.tableIndex !== 1) throw new Error('Same-view durable session did not retain its actual checkpoint')
    await target.destroy()
    same(await (await IdbSnapshotSyncJournal.open(target)).checkpoint(identityKey, 'source'), equalOutcome.checkpoint)
    if (Date.now() >= expiresAt) throw new Error('Original proof case admission expired')
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
