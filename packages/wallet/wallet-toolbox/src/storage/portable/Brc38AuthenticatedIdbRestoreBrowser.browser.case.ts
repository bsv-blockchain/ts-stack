import { browserSnapshotRestoreFixture as fixture } from '../../../test/utils/browserSnapshotRestoreFixture'
import { deleteDB, openDB } from 'idb'
import { StorageIdb } from '../StorageIdb'
import { StorageProvider } from '../StorageProvider'
import { WalletStorageManager } from '../WalletStorageManager'
import { previewAuthenticatedBrc39BrowserImport } from './Brc38AuthenticatedIdbPreviewBrowser'
import { packedIdbStores } from '../idbPackedFields'
import { idbImportJournalStores } from '../idbImportJournalSchema'
import { brc38ImportTableOrder } from './Brc38ImportForms'
import {
  restoreAuthenticatedBrc39BrowserInactive,
  publishAuthenticatedBrc39BrowserProfile
} from './Brc38AuthenticatedIdbRestoreBrowser'

// Authored UNRUN. Actual browser IndexedDB/Web Locks/WebCrypto/KDF/provider.
// Native whole AES-GCM/header/hash/UTF16 oracles are bounded test fixtures.
// Synthetic chain services are explicit protocol oracles, not live-chain,
// worker-crash, physical-memory, global-reference or activation qualification.
function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('Independent complete browser restore oracle differs')
}
function hex(bytes: Uint8Array) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}
async function sha(bytes: Uint8Array) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)))
}
async function failure(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work()
  } catch (cause) {
    return cause
  }
  throw new Error('Complete browser restore admitted a refused operation')
}
async function* chunks(bytes: Uint8Array) {
  for (let at = 0; at < bytes.length; at += 4093) yield bytes.slice(at, at + 4093)
}
export async function verifyCompleteBrowserRestoreResumeAndIndependentNativeInventory(): Promise<void> {
  const f = await fixture(),
    inspection = await openDB(f.storage.dbName, 7),
    original = f.bytes.slice()
  try {
    const partial = await restoreAuthenticatedBrc39BrowserInactive(chunks(f.bytes), f.password, {
      ...f.options,
      maximumRowsThisInvocation: 3
    })
    equal(
      [partial.receipt.nextRow, partial.receipt.state, partial.inventory, partial.inactive],
      [3, 'COMMITTED', undefined, true]
    )
    equal(f.working.used, 0)
    const complete = await restoreAuthenticatedBrc39BrowserInactive(
      chunks(f.bytes),
      f.password.normalize('NFC'),
      f.options
    )
    equal(
      [complete.receipt.nextRow, complete.receipt.state, complete.inventory?.rows],
      [f.options.admission.totalRows, 'COMPLETE', f.options.admission.totalRows]
    )
    if (f.roots < 2 || f.headers < 2 || complete.inventory?.unmappedHistoryIds !== 1)
      throw new Error('Current independent proof/history oracle was not repeated')
    equal(f.working.used, 0)
    equal(Array.from(f.bytes), Array.from(original))
    for (const [table, store] of [
      ['provenTxs', 'proven_txs'],
      ['outputBaskets', 'output_baskets'],
      ['outputTags', 'output_tags'],
      ['txLabels', 'tx_labels'],
      ['transactions', 'transactions'],
      ['outputs', 'outputs'],
      ['txLabelMaps', 'tx_labels_map'],
      ['outputTagMaps', 'output_tags_map'],
      ['certificates', 'certificates'],
      ['certificateFields', 'certificate_fields'],
      ['commissions', 'commissions'],
      ['provenTxReqs', 'proven_tx_reqs'],
      ['syncStates', 'sync_states']
    ] as const)
      equal(await inspection.count(store), f.data.tables[table].length)
    const user = await inspection.get('users', 1)
    equal([user.activeStorage, user.identityKey], ['', f.options.source.binding.identityKey])
    const proof = await inspection.get('proven_txs', 1),
      request = await inspection.get('proven_tx_reqs', 1),
      sync = await inspection.get('sync_states', 1)
    equal(proof.txid, f.txid)
    equal(sync.init, false)
    const readNative = async (descriptor: { content: string; bytes: number; sha256: string }) => {
      const output = new Uint8Array(descriptor.bytes)
      for (let offset = 0; offset < output.length; offset += 65536) {
        const chunk = await inspection.get(packedIdbStores.chunks, [descriptor.content, offset / 65536])
        equal(chunk.data.byteLength, Math.min(65536, output.length - offset))
        equal(hex(await sha(chunk.data)), chunk.sha256)
        output.set(chunk.data, offset)
      }
      equal(hex(await sha(output)), descriptor.sha256)
      return output
    }
    equal(Array.from(await readNative(proof.__walletPackedV1.rawTx)), Array.from(f.raw))
    equal(Array.from(await readNative(proof.__walletPackedV1.merklePath)), Array.from(f.merkle))
    const notify = JSON.parse(
        new TextDecoder('utf-16le', { fatal: true }).decode(await readNative(request.__walletPackedV1.notify))
      ),
      mapped = JSON.parse(
        new TextDecoder('utf-16le', { fatal: true }).decode(await readNative(sync.__walletPackedV1.syncMap))
      )
    // Compare the complete object data independently of JSON member order.
    // Canonical archive spelling sorts members; the fixture was inserted in
    // transactionIds/memo order. Both keys and every complete value must agree.
    equal(
      [Object.keys(notify).sort((a, b) => Number(a > b) - Number(a < b)), notify.transactionIds, notify.memo],
      [['memo', 'transactionIds'], [1], '😀雪'.repeat(12000)]
    )
    equal(mapped.output.idMap, { '160': 1 })
    const provenance = await inspection.get(idbImportJournalStores.originals, ['provenTxReqs', 0]),
      descriptors = JSON.parse(provenance.fieldsJson),
      originalNotify = JSON.parse(
        new TextDecoder('utf-16le', { fatal: true }).decode(await readNative(descriptors.notify))
      )
    const expectedNotify = f.data.tables.provenTxReqs[0].notify as Record<string, unknown>
    equal(
      [
        Object.keys(originalNotify).sort((a, b) => Number(a > b) - Number(a < b)),
        originalNotify.transactionIds,
        originalNotify.memo
      ],
      [
        Object.keys(expectedNotify).sort((a, b) => Number(a > b) - Number(a < b)),
        expectedNotify.transactionIds,
        expectedNotify.memo
      ]
    )
    equal(JSON.parse(provenance.destinationKeyJson), 1)
    const before = await inspection.get(packedIdbStores.clock, 'clock'),
      replay = await restoreAuthenticatedBrc39BrowserInactive(chunks(f.bytes), f.password, f.options)
    equal(replay.receipt, complete.receipt)
    equal(await inspection.get(packedIdbStores.clock, 'clock'), before)
    equal(f.working.used, 0)
  } finally {
    inspection.close()
    await f.storage.destroy()
    await deleteDB(f.storage.dbName)
  }
}
export async function verifyCompleteBrowserScalarTextRestoreAndOriginalInventory(): Promise<void> {
  const f = await fixture(true),
    inspection = await openDB(f.storage.dbName, 7),
    stores = {
      transactions: 'transactions',
      outputs: 'outputs',
      commissions: 'commissions',
      certificates: 'certificates',
      certificateFields: 'certificate_fields'
    } as const
  try {
    const partial = await restoreAuthenticatedBrc39BrowserInactive(chunks(f.bytes), f.password, {
      ...f.options,
      maximumRowsThisInvocation: 3
    })
    equal(partial.receipt.nextRow, 3)
    equal(f.working.used, 0)
    const complete = await restoreAuthenticatedBrc39BrowserInactive(chunks(f.bytes), f.password, f.options)
    equal([complete.receipt.state, complete.inventory?.rows], ['COMPLETE', f.options.admission.totalRows])
    const read = async (descriptor: { content: string; bytes: number; kind: string; sha256: string }) => {
      equal(descriptor.kind, 'utf16')
      const bytes = new Uint8Array(descriptor.bytes)
      for (let offset = 0; offset < bytes.length; offset += 65536) {
        const chunk = await inspection.get(packedIdbStores.chunks, [descriptor.content, offset / 65536])
        equal(chunk.data.length, Math.min(65536, bytes.length - offset))
        equal(hex(await sha(chunk.data)), chunk.sha256)
        bytes.set(chunk.data, offset)
      }
      equal(hex(await sha(bytes)), descriptor.sha256)
      return bytes
    }
    for (const expected of f.scalarOracle) {
      const store = stores[expected.table as keyof typeof stores]
      if (store === undefined) throw new Error('Independent scalar store oracle differs')
      const cursor = await inspection.transaction(store).store.openCursor()
      if (cursor === null) throw new Error('Independent scalar destination row absent')
      const original = await inspection.get(idbImportJournalStores.originals, [expected.table, 0]),
        provenance = JSON.parse(original.fieldsJson)[expected.field],
        field = cursor.value.__walletPackedV1[expected.field],
        destination = await read(field),
        archived = await read(provenance),
        oracle = new Uint8Array(2 * expected.value.length)
      for (let index = 0; index < expected.value.length; index++) {
        const unit = expected.value.charCodeAt(index)
        oracle[2 * index] = unit & 255
        oracle[2 * index + 1] = unit >>> 8
      }
      try {
        equal(Array.from(destination), Array.from(oracle))
        equal(Array.from(archived), Array.from(oracle))
        equal(new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true }).decode(destination), expected.value)
        if (Object.hasOwn(cursor.value, expected.field) || Object.hasOwn(JSON.parse(original.payload), expected.field))
          throw new Error('Browser scalar restore persisted a payload placeholder')
      } finally {
        destination.fill(0)
        archived.fill(0)
        oracle.fill(0)
      }
    }
    equal(f.working.used, 0)
    const clock = await inspection.get(packedIdbStores.clock, 'clock'),
      replay = await restoreAuthenticatedBrc39BrowserInactive(chunks(f.bytes), f.password, f.options)
    equal(replay.receipt, complete.receipt)
    equal(await inspection.get(packedIdbStores.clock, 'clock'), clock)
    equal(f.working.used, 0)
  } finally {
    inspection.close()
    await f.storage.destroy()
    await deleteDB(f.storage.dbName)
  }
}
export async function verifyCompleteBrowserRestoreLostAckAndAuthenticatedRefusal(): Promise<void> {
  const f = await fixture(),
    inspection = await openDB(f.storage.dbName, 7)
  try {
    const before = await inspection.get(packedIdbStores.clock, 'clock')
    await failure(() => restoreAuthenticatedBrc39BrowserInactive(chunks(f.bytes), 'wrong password', f.options))
    equal(await inspection.get(packedIdbStores.clock, 'clock'), before)
    equal(await inspection.count(idbImportJournalStores.journal), 0)
    const corrupt = f.bytes.slice()
    corrupt[corrupt.length - 1] ^= 1
    await failure(() => restoreAuthenticatedBrc39BrowserInactive(chunks(corrupt), f.password, f.options))
    equal(await inspection.get(packedIdbStores.clock, 'clock'), before)
    equal(await inspection.count('users'), 0)
    equal(f.working.used, 0)
    await failure(() =>
      restoreAuthenticatedBrc39BrowserInactive(chunks(f.bytes), f.password, {
        ...f.options,
        progress: progress => {
          if (progress.nextRow === 2) throw new Error('Independent lost acknowledgement after durable checkpoint')
        }
      })
    )
    const durable = await inspection.get(idbImportJournalStores.journal, 1)
    equal(JSON.parse(durable.receiptJson).nextRow, 2)
    equal(await inspection.count('proven_txs'), 1)
    equal(f.working.used, 0)
    const resumed = await restoreAuthenticatedBrc39BrowserInactive(chunks(f.bytes), f.password, f.options)
    equal(resumed.receipt.state, 'COMPLETE')
    equal(await inspection.count('proven_txs'), 1)
    equal(f.working.used, 0)
    f.setChainCurrent(false)
    await failure(() => restoreAuthenticatedBrc39BrowserInactive(chunks(f.bytes), f.password, f.options))
    equal(await inspection.count('proven_txs'), 1)
    equal((await inspection.get('users', 1)).activeStorage, '')
    equal(f.working.used, 0)
  } finally {
    inspection.close()
    await f.storage.destroy()
    await deleteDB(f.storage.dbName)
  }
}

/** Real Native transition/custody assertions, authored UNRUN. The chain oracle
 * remains the fixture's explicit synthetic protocol service. */
export async function verifyBrowserProfilePublicationActivationLostAckAndManagerRestart(): Promise<void> {
  const f = await fixture(),
    inspection = await openDB(f.storage.dbName, 7),
    identityKey = f.options.source.binding.identityKey,
    selectionOptions = { workingAllocation: f.working, expiresAt: f.options.admission.expiresAt }
  let reopened: StorageIdb | undefined
  try {
    await failure(() =>
      publishAuthenticatedBrc39BrowserProfile(
        chunks(f.bytes),
        f.password,
        {
          ...f.options,
          publicationProgress: value => {
            if (value.state === 'PUBLISHED') throw new Error('Independent lost publication ACK')
          }
        },
        'PUBLISHED'
      )
    )
    const pending = await f.storage.readRestoredProfileSelection(selectionOptions),
      pendingCell = await inspection.get(idbImportJournalStores.journal, 1)
    equal(
      [
        pending.publication.state,
        (await inspection.get('users', 1)).activeStorage,
        JSON.parse(pendingCell.receiptJson).state
      ],
      ['PUBLISHED', '', 'COMPLETE']
    )
    equal(f.working.used, 0)
    const pendingClock = await inspection.get(packedIdbStores.clock, 'clock')
    await failure(() => f.storage.updateUser(1, { activeStorage: f.options.source.binding.targetStorageIdentityKey }))
    equal(await inspection.get(packedIdbStores.clock, 'clock'), pendingClock)
    equal((await inspection.get('users', 1)).activeStorage, '')
    const empty = new WalletStorageManager(identityKey)
    await failure(() => empty.addRestoredBrowserStorageProvider(f.storage, selectionOptions))
    equal([empty._stores.length, empty.isAvailable()], [0, false])
    const before = await inspection.get(packedIdbStores.clock, 'clock'),
      proofCalls = f.roots
    await failure(() =>
      publishAuthenticatedBrc39BrowserProfile(
        chunks(f.bytes),
        f.password,
        {
          ...f.options,
          publicationProgress: value => {
            if (value.state === 'ACTIVATED') throw new Error('Independent lost activation ACK')
          }
        },
        'ACTIVATED'
      )
    )
    const activated = await f.storage.readRestoredProfileSelection(selectionOptions),
      after = await inspection.get(packedIdbStores.clock, 'clock')
    equal(
      [activated.publication.state, activated.publication.activatedRevision, after.revision],
      ['ACTIVATED', before.revision + 1, before.revision + 1]
    )
    equal((await inspection.get('users', 1)).activeStorage, f.options.source.binding.targetStorageIdentityKey)
    if (f.roots <= proofCalls) throw new Error('Activation skipped current authenticated proof replay')
    equal(f.working.used, 0)
    await failure(() => restoreAuthenticatedBrc39BrowserInactive(chunks(f.bytes), f.password, f.options))
    const recovered = await publishAuthenticatedBrc39BrowserProfile(chunks(f.bytes), f.password, f.options, 'ACTIVATED')
    equal(
      [recovered.inactive, recovered.publication?.state, recovered.receipt.nextRow],
      [false, 'ACTIVATED', f.options.admission.totalRows]
    )
    equal((await inspection.get(packedIdbStores.clock, 'clock')).revision, after.revision)
    equal(f.working.used, 0)
    const unchanged = await inspection.get(packedIdbStores.clock, 'clock')
    await publishAuthenticatedBrc39BrowserProfile(chunks(f.bytes), f.password, f.options, 'ACTIVATED')
    equal(await inspection.get(packedIdbStores.clock, 'clock'), unchanged)
    const foreign = new WalletStorageManager('another restored identity')
    await failure(() => foreign.addRestoredBrowserStorageProvider(f.storage, selectionOptions))
    equal(foreign._stores.length, 0)
    // A new actual provider/manager reopens durable selection without claiming
    // that an old archive verdict authenticates subsequent operational writes.
    const profileId = f.storage.dbName.slice(-32)
    await f.storage.destroy()
    reopened = new StorageIdb({
      ...StorageProvider.createStorageBaseOptions('test'),
      isolatedRestore: { profileId },
      packed: { maximumLogicalBytes: 16777216, maximumRecords: 10000 }
    })
    await reopened.migrate('Complete authenticated restore fixture', f.options.source.binding.targetStorageIdentityKey)
    const manager = new WalletStorageManager(identityKey)
    await manager.addRestoredBrowserStorageProvider(reopened, selectionOptions)
    equal(
      [manager.isActiveEnabled, manager.getActive() === reopened, manager.getActiveStore()],
      [true, true, f.options.source.binding.targetStorageIdentityKey]
    )
    equal(await inspection.get(packedIdbStores.clock, 'clock'), unchanged)
    equal(f.working.used, 0)
  } finally {
    inspection.close()
    await reopened?.destroy()
    await f.storage.destroy()
    await deleteDB(f.storage.dbName)
  }
}

export async function verifyBrowserPublicationCurrentChainAndNativeSelectionRefusal(): Promise<void> {
  const f = await fixture(),
    inspection = await openDB(f.storage.dbName, 7),
    selectionOptions = {
      workingAllocation: f.working,
      expiresAt: f.options.admission.expiresAt
    }
  try {
    await publishAuthenticatedBrc39BrowserProfile(chunks(f.bytes), f.password, f.options, 'PUBLISHED')
    const pending = await inspection.get(idbImportJournalStores.journal, 1),
      before = await inspection.get(packedIdbStores.clock, 'clock')
    f.setChainCurrent(false)
    await failure(() => publishAuthenticatedBrc39BrowserProfile(chunks(f.bytes), f.password, f.options, 'ACTIVATED'))
    equal(await inspection.get(idbImportJournalStores.journal, 1), pending)
    equal(await inspection.get(packedIdbStores.clock, 'clock'), before)
    equal((await inspection.get('users', 1)).activeStorage, '')
    equal(f.working.used, 0)
    f.setChainCurrent(true)
    // Direct native disagreement must not be repaired from copied transition
    // metadata or mistaken for an activated local wallet.
    const user = await inspection.get('users', 1)
    await inspection.put('users', { ...user, activeStorage: f.options.source.binding.targetStorageIdentityKey })
    await failure(() => f.storage.readRestoredProfileSelection(selectionOptions))
    await failure(() => publishAuthenticatedBrc39BrowserProfile(chunks(f.bytes), f.password, f.options, 'ACTIVATED'))
    await inspection.put('users', user)
    const publication = JSON.parse(pending.publicationJson)
    await inspection.put(
      idbImportJournalStores.journal,
      { ...pending, publicationJson: JSON.stringify({ ...publication, archiveSha256: 'f'.repeat(64) }) },
      1
    )
    await failure(() => f.storage.readRestoredProfileSelection(selectionOptions))
    await inspection.put(idbImportJournalStores.journal, pending, 1)
    const complete = await publishAuthenticatedBrc39BrowserProfile(chunks(f.bytes), f.password, f.options, 'ACTIVATED')
    equal(complete.publication?.state, 'ACTIVATED')
    equal(f.working.used, 0)
    const activeClock = await inspection.get(packedIdbStores.clock, 'clock'),
      activeUser = await inspection.get('users', 1)
    // A forward operational write is allowed. Selection recovery remains a
    // fresh native metadata read; the old restore controller must refuse its
    // now-stale immutable checkpoint instead of overwriting the live wallet.
    await f.storage.updateUser(1, { updated_at: new Date(activeUser.updated_at.getTime() + 1) })
    const current = await f.storage.readRestoredProfileSelection(selectionOptions)
    equal(current.revision, activeClock.revision + 1)
    const operational = await inspection.get(packedIdbStores.clock, 'clock')
    await failure(() => publishAuthenticatedBrc39BrowserProfile(chunks(f.bytes), f.password, f.options, 'ACTIVATED'))
    equal(await inspection.get(packedIdbStores.clock, 'clock'), operational)
    equal(f.working.used, 0)
    // A fresh READ deadline does not renew an expired import. Native selection
    // recovery after that original deadline performs no archive work or write.
    const actualNow = Date.now
    try {
      Date.now = () => f.options.admission.expiresAt + 1
      await failure(() => publishAuthenticatedBrc39BrowserProfile(chunks(f.bytes), f.password, f.options, 'ACTIVATED'))
      equal(
        (await f.storage.readRestoredProfileSelection({ ...selectionOptions, expiresAt: Date.now() + 30000 }))
          .publication.state,
        'ACTIVATED'
      )
    } finally {
      Date.now = actualNow
    }
    equal(await inspection.get(packedIdbStores.clock, 'clock'), operational)
    equal(f.working.used, 0)
  } finally {
    inspection.close()
    await f.storage.destroy()
    await deleteDB(f.storage.dbName)
  }
}

export async function verifyAuthenticatedBrowserPreviewHasNoDestinationEffectsOrAdmissionGrant(): Promise<void> {
  const f = await fixture(),
    inspection = await openDB(f.storage.dbName, 7),
    options = {
      source: f.options.source,
      proofStorage: f.storage,
      proof: f.options.row.proof,
      workingAllocation: f.working
    }
  try {
    const before = await inspection.get(packedIdbStores.clock, 'clock'),
      original = f.bytes.slice(),
      preview = await previewAuthenticatedBrc39BrowserImport(chunks(f.bytes), f.password, options)
    equal(
      [
        preview.mode,
        preview.totalRows,
        preview.maximumMappedIdsRequired,
        preview.bindingSha256,
        preview.originalLimitsJson
      ],
      [
        'isolated-restore',
        f.options.admission.totalRows,
        f.options.admission.maximumMappedIds,
        f.options.admission.scope.bindingSha256,
        f.options.admission.originalLimitsJson
      ]
    )
    equal(preview.originalActiveStorage, f.data.user.activeStorage)
    for (const table of brc38ImportTableOrder) equal(preview.counts[table], f.data.tables[table].length)
    equal(await inspection.get(packedIdbStores.clock, 'clock'), before)
    equal(await inspection.count('users'), 0)
    equal(await inspection.count(idbImportJournalStores.journal), 0)
    equal(Array.from(f.bytes), Array.from(original))
    equal(f.working.used, 0)
    const admitted = { ...f.options, admission: { ...f.options.admission, previewId: preview.previewId } }
    await failure(() => restoreAuthenticatedBrc39BrowserInactive(chunks(f.bytes), 'wrong password', admitted))
    equal(await inspection.get(packedIdbStores.clock, 'clock'), before)
    equal(await inspection.count('users'), 0)
    equal(f.working.used, 0)
    f.setChainCurrent(false)
    await failure(() => previewAuthenticatedBrc39BrowserImport(chunks(f.bytes), f.password, options))
    equal(await inspection.get(packedIdbStores.clock, 'clock'), before)
    equal(await inspection.count('users'), 0)
    equal(f.working.used, 0)
    f.setChainCurrent(true)
    const calls = f.roots,
      completed = await restoreAuthenticatedBrc39BrowserInactive(chunks(f.bytes), f.password, admitted)
    equal(completed.receipt.state, 'COMPLETE')
    if (f.roots <= calls) throw new Error('Copied preview data replaced current authentication/proof work')
    equal(f.working.used, 0)
  } finally {
    inspection.close()
    await f.storage.destroy()
    await deleteDB(f.storage.dbName)
  }
}
