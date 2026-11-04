import { StorageClient as StorageMobile } from '../../remoting/StorageMobile'
import { SnapshotJournalFieldArchiveTransport } from './SnapshotJournalFieldArchiveTransport'
import { encodeSnapshotJournalFieldFrame, decodeSnapshotJournalFieldFrame } from './SnapshotJournalDeltaFrame'
import type { RemoteSnapshotJournalFieldArchive } from './openRemoteSnapshotJournalFieldArchive'
import {
  retireSnapshotJournalDestinationWindow,
  replaceSnapshotJournalDestinationWindow
} from './SnapshotJournalDestinationWindow'
import {
  cleanupSnapshotJournalWindowCustody,
  cleanupSnapshotJournalAcknowledgedWindow,
  requireSnapshotJournalWindowClean
} from './SnapshotJournalWindowCleanup'
import * as RpcProofs from '../../remoting/validateRpcSyncProofs'
import * as FinancialProofs from '../../methods/validateSyncProof'
import { Transaction, LockingScript } from '@bsv/sdk'
import { knex } from 'knex'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StorageKnex } from '../../StorageKnex'
import { StorageProvider } from '../../StorageProvider'
import { StorageClient } from '../../remoting/StorageClient'
import { WalletStorageManager } from '../../WalletStorageManager'
import { snapshotHttpFixture } from '../../../../test/utils/snapshotArchiveHttpFixtures'
import { KnexSnapshotJournalDataDestination } from './KnexSnapshotJournalDataDestination'
import { journalCopyLimits } from './SnapshotJournalCopyLimits'
import { createHash } from 'node:crypto'
import {
  SnapshotJournalProvenanceFieldReader,
  readSnapshotJournalFieldProvenancePage,
  readSnapshotJournalProvenancePage
} from './SnapshotJournalProvenance'
import { snapshotJournalDestinationStreams } from './SnapshotJournalDestinationWindow'
import {
  encodeSnapshotJournalArchiveFrame,
  encodeSnapshotJournalArchiveIdentities
} from './SnapshotJournalArchivePacket'
import type { RemoteSnapshotJournalArchive } from './openRemoteSnapshotJournalArchive'
import type { SnapshotJournalDestinationCheckpoint } from './SnapshotJournalTypes'

// Match the source fixture's private Linux CI tmpfs without moving Jest caches
// or changing SQLite durability settings and the original receiver deadlines.
const fixtureTemporaryRoot = process.platform === 'linux' && process.env.CI === 'true' ? '/dev/shm' : tmpdir()

async function fixture(full = false) {
  const source = await snapshotHttpFixture(true, full),
    directory = await mkdtemp(join(fixtureTemporaryRoot, 'journal-data-target-'))
  const target = new StorageKnex({
    ...StorageProvider.createStorageBaseOptions('test'),
    knex: knex({
      client: 'better-sqlite3',
      connection: { filename: join(directory, 'target.sqlite') },
      useNullAsDefault: true,
      pool: { min: 0, max: 1 }
    })
  })
  const close = async () => {
    const results = await Promise.allSettled([source.close(), target.destroy()])
    await rm(directory, { recursive: true, force: true })
    const errors = results.flatMap(x => (x.status === 'rejected' ? [x.reason] : []))
    if (errors.length) throw new AggregateError(errors, 'Actual journal DATA fixture cleanup failed')
  }
  try {
    await target.knex.raw('PRAGMA journal_mode=WAL')
    await target.migrate('DATA journal target', 'journal-data-target')
    await target.makeAvailable()
    await target.findOrInsertUser(source.identityKey)
    const manager = new WalletStorageManager(source.identityKey, target)
    await manager.makeAvailable()
    await manager.setActive(target.getSettings().storageIdentityKey)
    const admission = async <T>(operation: () => Promise<T>) =>
      await manager.runAsWriter(async active => {
        if (active !== target) throw new Error('Actual target manager changed')
        return await operation()
      })
    const { url } = await source.serve(),
      client = new StorageClient(source.wallet, url, { serverIdentityKey: source.serverIdentityKey })
    return { source, target, manager, admission, client, close }
  } catch (error) {
    await close()
    throw error
  }
}
async function copy(
  archive: RemoteSnapshotJournalArchive,
  destination: KnexSnapshotJournalDataDestination,
  checkpoint: SnapshotJournalDestinationCheckpoint
) {
  for (let ordinal = checkpoint.sequence; ordinal < archive.frameCount; ordinal++) {
    const stream = snapshotJournalDestinationStreams[checkpoint.streamIndex],
      expected = checkpoint
    const frame = await archive.readFrame(ordinal, async (digest, index, identities) => {
      const prefix = encodeSnapshotJournalArchiveIdentities(
        stream,
        digest,
        index,
        identities,
        destination.binding.receipt.highWater
      )
      expect(await destination.stagePacket(expected, prefix)).toEqual(expected)
    })
    expect(frame.stream).toBe(stream.stream)
    expect(frame.tableId).toBe(stream.tableId)
    checkpoint = await destination.stagePacket(expected, encodeSnapshotJournalArchiveFrame(stream, frame.page))
  }
  const deadline = performance.now() + 10000
  while (checkpoint.phase !== 'acknowledged') {
    if (performance.now() >= deadline)
      throw new Error('Actual semantic promotion did not finish inside fixture deadline')
    checkpoint = (await destination.promote(checkpoint)).checkpoint
  }
  return checkpoint
}

test('actual HTTP artifact feeds a target-owned receiver, survives replacement, and promotes incremental tombstones without primary activation', async () => {
  const f = await fixture()
  let archive: RemoteSnapshotJournalArchive | undefined
  try {
    const user = (await f.source.storage.findOrInsertUser(f.source.identityKey)).user
    const original = await f.source.storage.findOrInsertTxLabel(user.userId, 'DATA original label')
    archive = await f.client.openSnapshotJournalArchive(f.source.identityKey)
    if (archive === undefined) throw new Error('Actual journal artifact unavailable')
    const first = await KnexSnapshotJournalDataDestination.begin(
      f.target,
      f.source.identityKey,
      archive.manifest.binding,
      journalCopyLimits(),
      f.admission
    )
    const checkpoint = await copy(archive, first.destination, first.checkpoint)
    expect(checkpoint.phase).toBe('acknowledged')
    expect(await f.target.findTxLabels({ partial: { label: 'DATA original label' } })).toHaveLength(1)
    const recovered = await KnexSnapshotJournalDataDestination.begin(
      f.target,
      f.source.identityKey,
      archive.manifest.binding,
      journalCopyLimits(),
      f.admission
    )
    expect((await recovered.destination.status()).checkpoint).toEqual(checkpoint)
    const replacement = await KnexSnapshotJournalDataDestination.resume(
      f.target,
      f.source.identityKey,
      archive.manifest.binding.sourceStorage.storageIdentityKey,
      journalCopyLimits(),
      f.admission
    )
    if (replacement === undefined) throw new Error('Actual durable receiver missing after replacement')
    expect((await replacement.status()).checkpoint).toEqual(checkpoint)

    const previous = archive.manifest.binding.journal.receipt
    await archive.close()
    await f.source.storage.knex('tx_labels').where('txLabelId', original.txLabelId).delete()
    await f.source.storage.findOrInsertTxLabel(user.userId, 'DATA next label')
    archive = await f.client.openSnapshotJournalArchive(f.source.identityKey, {
      binding: previous.binding,
      highWater: previous.highWater
    })
    if (archive === undefined) throw new Error('Actual incremental artifact unavailable')
    const next = await KnexSnapshotJournalDataDestination.begin(
      f.target,
      f.source.identityKey,
      archive.manifest.binding,
      journalCopyLimits(),
      f.admission
    )
    expect(next.destination.binding.bootstrap).toBeUndefined()
    expect(next.destination.binding.low).toBe(previous.highWater)
    expect((await copy(archive, next.destination, next.checkpoint)).phase).toBe('acknowledged')
    expect(await f.target.findTxLabels({ partial: { label: 'DATA next label' } })).toHaveLength(1)
    expect(
      await f.target.knex('snapshot_reconciliation_identity_maps').where({ incomingId: original.txLabelId, tableId: 3 })
    ).toHaveLength(0)
    expect((await f.target.findOrInsertUser(f.source.identityKey)).user.activeStorage).toBe('journal-data-target')
  } finally {
    await archive?.close()
    await f.close()
  }
})

test('DATA receiver refuses foreign identity and a changed current primary before accepting a frame', async () => {
  const f = await fixture()
  let archive: RemoteSnapshotJournalArchive | undefined
  try {
    archive = await f.client.openSnapshotJournalArchive(f.source.identityKey)
    if (archive === undefined) throw new Error('Actual journal artifact unavailable')
    await expect(
      KnexSnapshotJournalDataDestination.begin(
        f.target,
        '02' + '33'.repeat(32),
        archive.manifest.binding,
        journalCopyLimits(),
        f.admission
      )
    ).rejects.toThrow('authentication')
    expect(await f.target.knex('snapshot_reconciliation_windows')).toHaveLength(0)
    const begun = await KnexSnapshotJournalDataDestination.begin(
      f.target,
      f.source.identityKey,
      archive.manifest.binding,
      journalCopyLimits(),
      f.admission
    )
    const frame = await archive.readFrame(0, async () => {
      await f.target.knex('users').first()
    })
    const { user } = await f.target.findOrInsertUser(f.source.identityKey)
    await f.target.updateUser(user.userId, { activeStorage: 'changed-primary' })
    await expect(
      begun.destination.stagePacket(
        begun.checkpoint,
        encodeSnapshotJournalArchiveFrame(snapshotJournalDestinationStreams[0], frame.page)
      )
    ).rejects.toThrow()
    expect((await begun.destination.status()).checkpoint).toEqual(begun.checkpoint)
    expect(await f.target.knex('snapshot_reconciliation_stage_pages')).toHaveLength(0)
  } finally {
    await archive?.close()
    await f.close()
  }
})

test('DATA receiver rejects a freshly rehashed cross-profile row before advancing its ACK', async () => {
  const f = await fixture()
  let archive: RemoteSnapshotJournalArchive | undefined
  try {
    const user = (await f.source.storage.findOrInsertUser(f.source.identityKey)).user
    await f.source.storage.findOrInsertTxLabel(user.userId, 'profile-bound DATA')
    archive = await f.client.openSnapshotJournalArchive(f.source.identityKey)
    if (archive === undefined) throw new Error('Actual journal artifact unavailable')
    const begun = await KnexSnapshotJournalDataDestination.begin(
      f.target,
      f.source.identityKey,
      archive.manifest.binding,
      journalCopyLimits(),
      f.admission
    )
    let expected = begun.checkpoint
    for (let ordinal = 0; ordinal < archive.frameCount; ordinal++) {
      const stream = snapshotJournalDestinationStreams[expected.streamIndex]
      const frame = await archive.readFrame(ordinal, async (digest, index, identities) => {
        await begun.destination.stagePacket(
          expected,
          encodeSnapshotJournalArchiveIdentities(
            stream,
            digest,
            index,
            identities,
            begun.destination.binding.receipt.highWater
          )
        )
      })
      if (stream.stream === 'scope' && stream.tableId === 3) {
        expect(frame.page.changes.some(change => change.present && change.row.label === 'profile-bound DATA')).toBe(
          true
        )
        const forged = {
          ...frame.page,
          changes: frame.page.changes.map(change =>
            change.present ? { ...change, row: { ...change.row, userId: user.userId + 100 } } : change
          )
        }
        await expect(
          begun.destination.stagePacket(expected, encodeSnapshotJournalArchiveFrame(stream, forged))
        ).rejects.toThrow('different source profile')
        expect((await begun.destination.status()).checkpoint).toEqual(expected)
        expect(await f.target.knex('tx_labels')).toHaveLength(0)
        return
      }
      expected = await begun.destination.stagePacket(expected, encodeSnapshotJournalArchiveFrame(stream, frame.page))
    }
    throw new Error('Actual profile-bound frame was not visited')
  } finally {
    await archive?.close()
    await f.close()
  }
})

test('DATA receiver runs the real RPC proof policy before acknowledging an invalid original proof frame', async () => {
  const f = await fixture(true)
  let archive: RemoteSnapshotJournalArchive | undefined
  const validate = jest.spyOn(RpcProofs, 'validateSyncProofs')
  try {
    archive = await f.client.openSnapshotJournalArchive(f.source.identityKey)
    if (archive === undefined) throw new Error('Actual journal artifact unavailable')
    const begun = await KnexSnapshotJournalDataDestination.begin(
      f.target,
      f.source.identityKey,
      archive.manifest.binding,
      journalCopyLimits(),
      f.admission
    )
    let expected = begun.checkpoint
    for (let ordinal = 0; ordinal < archive.frameCount; ordinal++) {
      const stream = snapshotJournalDestinationStreams[expected.streamIndex]
      const frame = await archive.readFrame(ordinal, async (digest, index, identities) => {
        await begun.destination.stagePacket(
          expected,
          encodeSnapshotJournalArchiveIdentities(
            stream,
            digest,
            index,
            identities,
            begun.destination.binding.receipt.highWater
          )
        )
      })
      const packet = encodeSnapshotJournalArchiveFrame(stream, frame.page)
      if (stream.tableId === 8 && frame.page.changes.some(change => change.present)) {
        await expect(begun.destination.stagePacket(expected, packet)).rejects.toThrow()
        expect(validate).toHaveBeenCalledTimes(1)
        expect((await begun.destination.status()).checkpoint).toEqual(expected)
        expect(await f.target.knex('proven_txs')).toHaveLength(0)
        return
      }
      expected = await begun.destination.stagePacket(expected, packet)
    }
    throw new Error('Actual invalid fixture proof was not visited')
  } finally {
    validate.mockRestore()
    await archive?.close()
    await f.close()
  }
})

test('an actual owned field window cannot resume or bootstrap through the original row DATA receiver', async () => {
  const f = await fixture()
  let archive: RemoteSnapshotJournalArchive | undefined
  try {
    archive = await f.client.openSnapshotJournalArchive(f.source.identityKey)
    if (archive === undefined) throw new Error('Actual authenticated source unavailable')
    const original = await KnexSnapshotJournalDataDestination.begin(
        f.target,
        f.source.identityKey,
        archive.manifest.binding,
        journalCopyLimits(),
        f.admission
      ),
      fieldBinding = { ...original.destination.binding, fieldEncoding: 'wallet-journal-fields/1' as const }
    const fieldCheckpoint = await f.admission(
      async () =>
        await f.target.runSnapshotJournalWriter(async trx => {
          await retireSnapshotJournalDestinationWindow(trx, original.destination.binding, original.checkpoint)
          while (
            !(await cleanupSnapshotJournalWindowCustody(trx, original.destination.binding, original.checkpoint))
              .complete
          ) {
            // Each iteration performs actual bounded SQL custody cleanup.
          }
          return await replaceSnapshotJournalDestinationWindow(
            trx,
            original.destination.binding,
            original.checkpoint,
            fieldBinding,
            'ed'.repeat(32),
            async actual =>
              await requireSnapshotJournalWindowClean(actual, original.destination.binding, original.checkpoint)
          )
        })
    )
    const before = await f.target.knex('snapshot_reconciliation_windows').first()
    expect(JSON.parse(before.bindingJson).fieldEncoding).toBe('wallet-journal-fields/1')
    expect(fieldCheckpoint.phase).toBe('intake')
    await expect(
      KnexSnapshotJournalDataDestination.resume(
        f.target,
        f.source.identityKey,
        archive.manifest.binding.sourceStorage.storageIdentityKey,
        journalCopyLimits(),
        f.admission
      )
    ).rejects.toThrow('actual admitted window')
    await expect(
      KnexSnapshotJournalDataDestination.begin(
        f.target,
        f.source.identityKey,
        archive.manifest.binding,
        journalCopyLimits(),
        f.admission
      )
    ).rejects.toThrow('actual admitted window')
    expect(await f.target.knex('snapshot_reconciliation_windows').first()).toEqual(before)
    expect(await f.target.knex('snapshot_sync_journal_data_receipts').where('complete', 1)).toHaveLength(0)
    expect((await f.target.findOrInsertUser(f.source.identityKey)).user.activeStorage).toBe('journal-data-target')
  } finally {
    await archive?.close()
    await f.close()
  }
})

test('authenticated field DATA and copied frames cannot enroll an ordinary SQL row window as a native financial action', async () => {
  const { prepareSnapshotJournalNativeActionMerge } = await import('./SnapshotJournalNativeActionMerge')
  const f = await fixture(true)
  let archive: RemoteSnapshotJournalArchive | undefined, fields: RemoteSnapshotJournalFieldArchive | undefined
  try {
    archive = await f.client.openSnapshotJournalArchive(f.source.identityKey)
    if (archive === undefined) throw new Error('Actual original row source unavailable')
    const old = await KnexSnapshotJournalDataDestination.begin(
      f.target,
      f.source.identityKey,
      archive.manifest.binding,
      journalCopyLimits(),
      f.admission
    )
    await archive.close()
    await archive.closed
    fields = await f.client.openSnapshotJournalFieldArchive(f.source.identityKey)
    if (fields === undefined) throw new Error('Actual authenticated field source unavailable')
    let admissions = 0
    const frame = await fields.readFrame(0, async () => {
        expect(await f.target.knex('users').where('identityKey', f.source.identityKey).first()).toBeDefined()
      }),
      page = frame.page,
      bytes = encodeSnapshotJournalFieldFrame(page, { stream: frame.stream, tableId: frame.tableId }),
      receipt = {
        sequence: 1,
        streamIndex: 0,
        tableId: frame.tableId,
        examined: page.examined,
        bytes: bytes.length,
        digest: frame.frameDigest
      },
      admission = async <T>(operation: () => Promise<T>): Promise<T> => {
        admissions++
        return await f.admission(operation)
      },
      before = await f.target.knex('snapshot_reconciliation_windows').first()
    expect(page.changes.some(change => change.present)).toBe(true)
    await expect(
      prepareSnapshotJournalNativeActionMerge(
        f.target,
        old.destination.binding,
        old.checkpoint,
        receipt,
        0,
        fields,
        structuredClone(frame),
        journalCopyLimits(),
        admission
      )
    ).rejects.toThrow('actual opened artifact')
    await expect(
      prepareSnapshotJournalNativeActionMerge(
        f.target,
        old.destination.binding,
        old.checkpoint,
        receipt,
        0,
        fields,
        frame,
        journalCopyLimits(),
        admission
      )
    ).rejects.toThrow('actual field/window/current ownership')
    expect(admissions).toBe(0)
    expect(await f.target.knex('snapshot_reconciliation_windows').first()).toEqual(before)
    expect(await f.target.knex('transactions')).toHaveLength(0)
    expect(await f.target.knex('outputs')).toHaveLength(0)
    expect(await f.target.knex('snapshot_sync_journal_data_receipts').where('complete', 1)).toHaveLength(0)
  } finally {
    await fields?.close()
    await archive?.close()
    await f.close()
  }
})

test('actual field intake retains large-field descriptors, resumes its own window, and refuses copied archive frames without a financial ACK', async () => {
  const { KnexSnapshotJournalFieldDestination } = await import('./KnexSnapshotJournalFieldDestination')
  const f = await fixture(true),
    bytes = Buffer.alloc(2097152, 107)
  let archive: RemoteSnapshotJournalFieldArchive | undefined
  try {
    await f.source.storage.knex('transactions').where('transactionId', 1).update({ rawTx: bytes })
    archive = await f.client.openSnapshotJournalFieldArchive(f.source.identityKey)
    if (archive === undefined) throw new Error('Actual authenticated field artifact unavailable')
    const begun = await KnexSnapshotJournalFieldDestination.begin(
      f.target,
      f.source.identityKey,
      archive.manifest.binding,
      journalCopyLimits(),
      f.admission
    )
    expect(begun.destination.binding.fieldEncoding).toBe('wallet-journal-fields/1')
    await expect(
      KnexSnapshotJournalDataDestination.resume(
        f.target,
        f.source.identityKey,
        archive.manifest.binding.sourceStorage.storageIdentityKey,
        journalCopyLimits(),
        f.admission
      )
    ).rejects.toThrow('actual admitted window')
    const actual = archive,
      copied = {
        ...archive,
        readFrame: async (...args: Parameters<typeof actual.readFrame>) =>
          structuredClone(await actual.readFrame(...args))
      }
    await expect(begun.destination.stageArchiveFrame(begun.checkpoint, copied)).rejects.toThrow(
      'actual opened artifact'
    )
    expect((await begun.destination.status()).checkpoint).toEqual(begun.checkpoint)
    expect(
      await f.target.knex('snapshot_reconciliation_captured_identities').where('sessionId', begun.checkpoint.sessionId)
    ).toHaveLength(0)
    const next = await begun.destination.stageArchiveFrame(begun.checkpoint, actual)
    expect(next.sequence).toBe(1)
    expect(next.phase).toBe('intake')
    const staged = await f.target
      .knex('snapshot_reconciliation_stage_pages')
      .where('sessionId', next.sessionId)
      .select('tableId', 'payload')
    expect(staged).toHaveLength(1)
    const page = decodeSnapshotJournalFieldFrame(new Uint8Array(staged[0].payload), { stream: 'scope', tableId: 0 }),
      selected = page.changes.find(change => change.present && change.metadata.id1 === 1)
    if (selected === undefined || !selected.present) throw new Error('Actual staged source transaction missing')
    expect(selected.fields.rawTx.bytes).toBe(bytes.length)
    expect(selected.row).not.toHaveProperty('rawTx')
    expect(staged[0].payload.length).toBeLessThan(262144)
    expect(await f.target.knex('transactions')).toHaveLength(0)
    expect(await f.target.knex('snapshot_sync_journal_data_receipts').where('complete', 1)).toHaveLength(0)
    const resumed = await KnexSnapshotJournalFieldDestination.resume(
      f.target,
      f.source.identityKey,
      actual.manifest.binding.sourceStorage.storageIdentityKey,
      journalCopyLimits(),
      f.admission
    )
    if (resumed === undefined) throw new Error('Actual durable field window unavailable')
    expect((await resumed.status()).checkpoint).toEqual(next)
    await actual.close()
    await actual.closed
    await expect(resumed.stageArchiveFrame(next, actual)).rejects.toThrow('actual admitted artifact/window')
    expect((await resumed.status()).checkpoint).toEqual(next)
  } finally {
    bytes.fill(0)
    await archive?.close()
    await f.close()
  }
})

test('ordinary SQL field effects preserve full binary and UTF8 payloads, remap parents and retain original financial update policy', async () => {
  const { KnexSnapshotJournalFieldDestination } = await import('./KnexSnapshotJournalFieldDestination')
  const f = await fixture()
  const captureModule = await import('./captureSnapshotJournalFieldArchiveSource'),
    actualCapture = captureModule.captureSnapshotJournalFieldArchiveSource,
    captureErrors: unknown[] = [],
    captureSpy = jest
      .spyOn(captureModule, 'captureSnapshotJournalFieldArchiveSource')
      .mockImplementation(async (...args) => {
        try {
          return await actualCapture(...args)
        } catch (cause) {
          captureErrors.push(cause)
          throw cause
        }
      })
  let archive: RemoteSnapshotJournalFieldArchive | undefined
  const script = Buffer.from([
      0x6a,
      0x4e,
      0x70,
      0x11,
      0x01,
      0x00,
      ...Array.from({ length: 70000 }, (_v, at) => at % 251)
    ]),
    tx = new Transaction(1, [], [{ satoshis: 1, lockingScript: LockingScript.fromBinary(Array.from(script)) }], 0),
    raw = Buffer.from(tx.toBinary()),
    text = 'independent 雪\u0000' + '🧾'.repeat(45000),
    key = 'original secret custody 雪'.repeat(300)
  try {
    const sourceUser = (await f.source.storage.findOrInsertUser(f.source.identityKey)).user.userId,
      targetUser = f.manager.getActiveUser().userId,
      stamp = { created_at: Date.now(), updated_at: Date.now() }
    await f.source.storage.knex('transactions').insert({
      ...stamp,
      transactionId: 11,
      userId: sourceUser,
      status: 'unprocessed',
      reference: 'ordinary-field-tx',
      isOutgoing: 0,
      satoshis: 1,
      txid: tx.id('hex'),
      version: 1,
      lockTime: 0,
      description: 'ordinary field transaction',
      rawTx: raw
    })
    await f.source.storage
      .knex('output_baskets')
      .insert({ ...stamp, basketId: 17, userId: sourceUser, name: 'ordinary field basket', isDeleted: 0 })
    await f.source.storage.knex('outputs').insert({
      ...stamp,
      outputId: 19,
      userId: sourceUser,
      transactionId: 11,
      basketId: 17,
      spendable: 0,
      change: 0,
      vout: 0,
      satoshis: 1,
      providedBy: 'you',
      purpose: '',
      type: 'P2PKH',
      lockingScript: script,
      outputDescription: 'source output field'
    })
    await f.source.storage.knex('certificates').insert({
      ...stamp,
      certificateId: 23,
      userId: sourceUser,
      type: 'ordinary',
      serialNumber: 'ordinary-field-cert',
      certifier: f.source.identityKey,
      subject: f.source.identityKey,
      revocationOutpoint: 'a'.repeat(64) + '.0',
      signature: 'ab'.repeat(64),
      isDeleted: 0
    })
    await f.source.storage.knex('certificate_fields').insert({
      ...stamp,
      userId: sourceUser,
      certificateId: 23,
      fieldName: 'independent 雪',
      fieldValue: text,
      masterKey: key
    })
    await f.source.storage.knex('commissions').insert({
      ...stamp,
      commissionId: 29,
      userId: sourceUser,
      transactionId: 11,
      isRedeemed: 0,
      satoshis: 0,
      keyOffset: 'original commission offset',
      lockingScript: script
    })
    // Occupied target keys prove actual remapping, rather than coincidental IDs.
    await f.target.knex('transactions').insert({
      ...stamp,
      transactionId: 73,
      userId: targetUser,
      status: 'unprocessed',
      reference: 'retained-target-tx',
      isOutgoing: 0,
      satoshis: 0,
      description: 'retained target'
    })
    await f.target.knex('certificates').insert({
      ...stamp,
      certificateId: 83,
      userId: targetUser,
      type: 'retained',
      serialNumber: 'retained-cert',
      certifier: f.source.identityKey,
      subject: f.source.identityKey,
      revocationOutpoint: 'b'.repeat(64) + '.0',
      signature: 'cd'.repeat(64),
      isDeleted: 0
    })
    const run = async (position?: import('./SnapshotJournalReceiptData').SnapshotJournalArchivePosition) => {
      const controller = new AbortController(),
        started = performance.now(),
        timer = setTimeout(() => controller.abort(new Error('Owned ordinary field phase deadline')), 180000)
      try {
        archive = await f.client.openSnapshotJournalFieldArchive(f.source.identityKey, position, {
          lifetimeMs: 180000,
          signal: controller.signal
        })
        if (archive === undefined) throw new AggregateError(captureErrors, 'Actual ordinary field archive unavailable')
        const begun = await KnexSnapshotJournalFieldDestination.begin(
          f.target,
          f.source.identityKey,
          archive.manifest.binding,
          journalCopyLimits(),
          f.admission,
          controller.signal
        )
        let state = begun.checkpoint
        for (let ordinal = 0; ordinal < archive.frameCount; ordinal++)
          state = await begun.destination.stageArchiveFrame(state, archive)
        let previousTable = -1
        while (state.phase !== 'acknowledged') {
          if (state.tableIndex !== previousTable) {
            console.log(
              JSON.stringify({
                stage: 'ordinary-field-promotion',
                incremental: position !== undefined,
                tableIndex: state.tableIndex,
                elapsedMs: performance.now() - started
              })
            )
            previousTable = state.tableIndex
          }
          state = (await begun.destination.promote(state, archive)).checkpoint
        }
        const receipt = archive.manifest.binding.journal.receipt
        await archive.close()
        await archive.closed
        return receipt
      } finally {
        clearTimeout(timer)
        await archive?.close()
        await archive?.closed
      }
    }
    const receipt = await run(),
      copiedTx = await f.target.knex('transactions').where('txid', tx.id('hex')).first(),
      copiedOutput = await f.target.knex('outputs').where('transactionId', copiedTx.transactionId).first(),
      copiedCertificate = await f.target.knex('certificates').where('serialNumber', 'ordinary-field-cert').first(),
      copiedField = await f.target
        .knex('certificate_fields')
        .where('certificateId', copiedCertificate.certificateId)
        .first(),
      copiedCommission = await f.target.knex('commissions').where('transactionId', copiedTx.transactionId).first()
    expect(copiedTx.transactionId).not.toBe(11)
    expect(copiedCertificate.certificateId).not.toBe(23)
    expect(copiedTx.rawTx).toEqual(raw)
    expect(copiedOutput.lockingScript).toEqual(script)
    expect((await f.target.knex('output_baskets').where('basketId', copiedOutput.basketId).first()).name).toBe(
      'ordinary field basket'
    )
    expect(copiedField).toMatchObject({
      fieldName: 'independent 雪',
      fieldValue: text,
      masterKey: key,
      userId: targetUser
    })
    expect(copiedCommission.lockingScript).toEqual(script)
    const next = stamp.updated_at + 1000
    await f.source.storage
      .knex('certificate_fields')
      .where('certificateId', 23)
      .update({ updated_at: next, fieldValue: text + ' revised', masterKey: key + ' revised' })
    await f.source.storage
      .knex('commissions')
      .where('commissionId', 29)
      .update({
        updated_at: next,
        isRedeemed: 1,
        lockingScript: Buffer.from([0x51]),
        keyOffset: 'must not replace occupied commission'
      })
    await run({ binding: receipt.binding, highWater: receipt.highWater })
    expect(
      await f.target.knex('certificate_fields').where('certificateId', copiedCertificate.certificateId).first()
    ).toMatchObject({ fieldValue: text + ' revised', masterKey: key + ' revised' })
    expect(
      await f.target.knex('commissions').where('commissionId', copiedCommission.commissionId).first()
    ).toMatchObject({
      isRedeemed: 1,
      lockingScript: script,
      keyOffset: 'original commission offset',
      transactionId: copiedTx.transactionId
    })
    expect(await f.target.knex('transactions').where('transactionId', 73).first()).toMatchObject({
      reference: 'retained-target-tx',
      description: 'retained target'
    })
    expect((await f.target.findOrInsertUser(f.source.identityKey)).user.activeStorage).toBe('journal-data-target')
  } finally {
    raw.fill(0)
    script.fill(0)
    await archive?.close()
    await f.close()
    captureSpy.mockRestore()
  }
}, 400000)

test('ordinary SQL field proof failure runs the original cryptographic validator before financial mutation or acknowledgement', async () => {
  const { KnexSnapshotJournalFieldDestination } = await import('./KnexSnapshotJournalFieldDestination'),
    f = await fixture(),
    proof = jest.spyOn(FinancialProofs, 'validateSyncProof'),
    controller = new AbortController(),
    timer = setTimeout(() => controller.abort(new Error('Owned field proof phase deadline')), 90000)
  let archive: RemoteSnapshotJournalFieldArchive | undefined
  try {
    await f.source.storage.knex('proven_txs').insert({
      created_at: Date.now(),
      updated_at: Date.now(),
      provenTxId: 7,
      txid: 'a'.repeat(64),
      height: 1,
      index: 0,
      blockHash: 'b'.repeat(64),
      merkleRoot: 'c'.repeat(64),
      rawTx: Buffer.from([1, 2, 3]),
      merklePath: Buffer.from([4, 5, 6])
    })
    const userId = (await f.source.storage.findOrInsertUser(f.source.identityKey)).user.userId
    await f.source.storage.knex('transactions').insert({
      created_at: Date.now(),
      updated_at: Date.now(),
      transactionId: 11,
      userId,
      provenTxId: 7,
      status: 'completed',
      reference: 'invalid-field-proof',
      isOutgoing: 0,
      satoshis: 0,
      description: 'independent invalid proof',
      txid: 'a'.repeat(64)
    })
    archive = await f.client.openSnapshotJournalFieldArchive(f.source.identityKey, undefined, {
      lifetimeMs: 90000,
      signal: controller.signal
    })
    if (archive === undefined) throw new Error('Actual proof field archive unavailable')
    const begun = await KnexSnapshotJournalFieldDestination.begin(
      f.target,
      f.source.identityKey,
      archive.manifest.binding,
      journalCopyLimits(),
      f.admission,
      controller.signal
    )
    let state = begun.checkpoint
    for (let ordinal = 0; ordinal < archive.frameCount; ordinal++)
      state = await begun.destination.stageArchiveFrame(state, archive)
    let failure: unknown
    for (let attempt = 0; attempt < archive.frameCount + 13; attempt++) {
      try {
        state = (await begun.destination.promote(state, archive)).checkpoint
      } catch (cause) {
        failure = cause
        break
      }
    }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('server-verified proof')
    expect(proof).toHaveBeenCalled()
    expect((await begun.destination.status()).checkpoint).toEqual(state)
    expect(await f.target.knex('proven_txs')).toHaveLength(0)
    expect(await f.target.knex('snapshot_sync_journal_data_receipts').where('complete', 1)).toHaveLength(0)
  } finally {
    clearTimeout(timer)
    proof.mockRestore()
    await archive?.close()
    await f.close()
  }
}, 120000)

test('actual field receiver commits complete semantic rows and recovers a lost final financial ACK without replaying the merge', async () => {
  const { KnexSnapshotJournalFieldDestination } = await import('./KnexSnapshotJournalFieldDestination')
  const f = await fixture()
  let archive: RemoteSnapshotJournalFieldArchive | undefined
  let dropReply = true
  let lost = false
  const admission = async <T>(operation: () => Promise<T>) =>
    await f.admission(async () => {
      const result = await operation()
      if (
        dropReply &&
        result !== null &&
        typeof result === 'object' &&
        Reflect.get(result, 'checkpoint') !== null &&
        typeof Reflect.get(result, 'checkpoint') === 'object' &&
        Reflect.get(Reflect.get(result, 'checkpoint') as object, 'phase') === 'acknowledged'
      ) {
        dropReply = false
        throw new Error('Independent field final reply lost after actual SQL commit')
      }
      return result
    })
  try {
    const incoming = await f.source.storage.findOrInsertTxLabel(
      (await f.source.storage.findOrInsertUser(f.source.identityKey)).user.userId,
      'field semantic label'
    )
    const local = await f.target.findOrInsertTxLabel(f.manager.getActiveUser().userId, 'retained local field label')
    archive = await f.client.openSnapshotJournalFieldArchive(f.source.identityKey)
    if (archive === undefined) throw new Error('Actual authenticated field artifact unavailable')
    const begun = await KnexSnapshotJournalFieldDestination.begin(
      f.target,
      f.source.identityKey,
      archive.manifest.binding,
      journalCopyLimits(),
      admission
    )
    let state = begun.checkpoint
    for (let index = 0; index < archive.frameCount; index++)
      state = await begun.destination.stageArchiveFrame(state, archive)
    expect(state.phase).toBe('promoting')
    expect(await f.target.findTxLabels({ partial: { label: 'field semantic label' } })).toHaveLength(0)
    const deadline = performance.now() + 10000
    while (state.phase !== 'acknowledged') {
      if (performance.now() >= deadline)
        throw new Error('Actual field semantic promotion exceeded its original bounded fixture phase')
      try {
        state = (await begun.destination.promote(state, archive)).checkpoint
      } catch (cause) {
        if (!(cause instanceof Error) || cause.message !== 'Independent field final reply lost after actual SQL commit')
          throw cause
        lost = true
        break
      }
    }
    expect(lost).toBe(true)
    const restored = await KnexSnapshotJournalFieldDestination.resume(
      f.target,
      f.source.identityKey,
      archive.manifest.binding.sourceStorage.storageIdentityKey,
      journalCopyLimits(),
      admission
    )
    if (restored === undefined) throw new Error('Actual durable field receiver unavailable after lost reply')
    expect((await restored.status()).checkpoint.phase).toBe('acknowledged')
    const copied = await f.target.findTxLabels({ partial: { label: 'field semantic label' } })
    expect(copied).toHaveLength(1)
    expect(copied[0].txLabelId).not.toBe(incoming.txLabelId)
    expect(await f.target.findTxLabels({ partial: { txLabelId: local.txLabelId } })).toHaveLength(1)
    const mappings = await f.target
      .knex('snapshot_reconciliation_identity_maps')
      .where({ incomingId: incoming.txLabelId, tableId: 3 })
    expect(mappings).toHaveLength(1)
    expect(mappings[0].localId).toBe(copied[0].txLabelId)
    expect(await f.target.knex('snapshot_sync_journal_data_receipts').where('complete', 1)).toHaveLength(1)
    expect((await f.target.findOrInsertUser(f.source.identityKey)).user.activeStorage).toBe('journal-data-target')
  } finally {
    await archive?.close()
    await f.close()
  }
})

test('actual field provenance retains complete UTF8 bytes after archive closure and refuses changed stored-byte revisions', async () => {
  const { KnexSnapshotJournalFieldDestination } = await import('./KnexSnapshotJournalFieldDestination')
  const f = await fixture()
  const captureModule = await import('./captureSnapshotJournalFieldArchiveSource'),
    actualCapture = captureModule.captureSnapshotJournalFieldArchiveSource,
    captureErrors: unknown[] = [],
    captureSpy = jest
      .spyOn(captureModule, 'captureSnapshotJournalFieldArchiveSource')
      .mockImplementation(async (...args) => {
        try {
          return await actualCapture(...args)
        } catch (cause) {
          captureErrors.push(cause)
          throw cause
        }
      })
  const actualOpen = f.source.storage.openSnapshotSyncContentSource.bind(f.source.storage),
    openSpy = jest.spyOn(f.source.storage, 'openSnapshotSyncContentSource').mockImplementation(async (...args) => {
      try {
        return await actualOpen(...args)
      } catch (cause) {
        captureErrors.push(cause)
        throw cause
      }
    })
  let archive: RemoteSnapshotJournalFieldArchive | undefined,
    reader: import('./SnapshotJournalDataProvider').SnapshotJournalStoredFieldReader | undefined,
    restoreWriter = () => undefined as void
  const text = 'independent provenance 雪\u0000' + '🧾'.repeat(9000),
    bytes = Buffer.from(text, 'utf8'),
    incomingId = -7
  try {
    const user = (await f.source.storage.findOrInsertUser(f.source.identityKey)).user,
      timestamp = { created_at: Date.now(), updated_at: Date.now() }
    await f.source.storage.knex('sync_states').insert({
      ...timestamp,
      syncStateId: incomingId,
      userId: user.userId,
      storageIdentityKey: 'independent-source-peer',
      storageName: 'source peer',
      refNum: 'independent-field-provenance',
      status: 'unknown',
      init: 1,
      syncMap: text,
      errorLocal: '',
      errorOther: null
    })
    const before = await f.target.knex('sync_states').orderBy('syncStateId')
    expect(await f.source.storage.knex('snapshot_journal_clock').first('enabled', 'reason')).toEqual({
      enabled: 1,
      reason: null
    })
    await (await import('./SnapshotJournalLifecycle')).readSnapshotJournalCaptureConfiguration(f.source.storage.knex)
    const rawArchive = await f.client.openSnapshotJournalArchive(f.source.identityKey)
    if (rawArchive === undefined) throw new Error('Actual original complete-row archive unavailable')
    try {
      const raw = await KnexSnapshotJournalDataDestination.begin(
        f.target,
        f.source.identityKey,
        rawArchive.manifest.binding,
        journalCopyLimits(),
        f.admission
      )
      const rawState = await copy(rawArchive, raw.destination, raw.checkpoint)
      const original = await f.admission(
        async () =>
          await f.target.runSnapshotJournalWriter(
            async trx => await readSnapshotJournalProvenancePage(trx, raw.destination.binding, rawState),
            raw.destination.binding.destinationBackend
          )
      )
      expect(original.rows[0].raw.syncMap).toBe(text)
    } finally {
      await rawArchive.close()
      await rawArchive.closed
    }
    try {
      archive = await f.client.openSnapshotJournalFieldArchive(f.source.identityKey)
    } catch (cause) {
      throw new AggregateError([cause, ...captureErrors], 'Actual provenance artifact capture failed')
    }
    if (archive === undefined) throw new Error('Actual authenticated field artifact unavailable')
    const begun = await KnexSnapshotJournalFieldDestination.begin(
      f.target,
      f.source.identityKey,
      archive.manifest.binding,
      journalCopyLimits(),
      f.admission
    )
    const actualWriter = f.target.runSnapshotJournalWriter.bind(f.target),
      rollback = new Error('Independent provenance final writer rollback')
    let rolledBack = false
    const writerSpy = jest.spyOn(f.target, 'runSnapshotJournalWriter').mockImplementation(
      async <T>(
        operation: (trx: import('knex').Knex, backend: string) => Promise<T>,
        expectedBackend?: string,
        signal?: AbortSignal
      ): Promise<T> =>
        await actualWriter(
          async (trx, backend) => {
            const result = await operation(trx, backend)
            if (
              !rolledBack &&
              result !== null &&
              typeof result === 'object' &&
              Reflect.get(result, 'phase') === 'intake' &&
              Reflect.get(result, 'streamIndex') === 8
            ) {
              rolledBack = true
              throw rollback
            }
            return result
          },
          expectedBackend,
          signal
        )
    )
    restoreWriter = () => writerSpy.mockRestore()
    let state = begun.checkpoint
    for (let ordinal = 0; ordinal < archive.frameCount; ordinal++) {
      if (state.streamIndex === 7) {
        await expect(begun.destination.stageArchiveFrame(state, archive)).rejects.toBe(rollback)
        expect((await begun.destination.status()).checkpoint).toEqual(state)
        expect(await f.target.knex('snapshot_reconciliation_pf_versions').select('state', 'linked')).toEqual([
          { state: 'SEALED', linked: 0 },
          { state: 'SEALED', linked: 0 }
        ])
        expect((await f.target.knex('snapshot_reconciliation_pf_budgets').first()).reserved).toBe(bytes.length)
      }
      state = await begun.destination.stageArchiveFrame(state, archive)
    }
    expect(rolledBack).toBe(true)
    while (state.phase !== 'acknowledged') state = (await begun.destination.promote(state, archive)).checkpoint
    await archive.close()
    await archive.closed
    expect(await f.target.knex('sync_states').orderBy('syncStateId')).toEqual(before)
    const read = async <T>(operation: (trx: import('knex').Knex) => Promise<T>) =>
      await f.admission(
        async () =>
          await f.target.runSnapshotJournalWriter(
            async trx => await operation(trx),
            begun.destination.binding.destinationBackend
          )
      )
    await expect(
      read(async trx => await readSnapshotJournalProvenancePage(trx, begun.destination.binding, state))
    ).rejects.toThrow()
    const page = await read(
      async trx => await readSnapshotJournalFieldProvenancePage(trx, begun.destination.binding, state)
    )
    expect(page.rows).toHaveLength(1)
    expect(page.rows[0]).toMatchObject({
      incomingId,
      small: { syncStateId: incomingId, userId: user.userId, errorOther: null },
      fields: {
        syncMap: { kind: 'utf8', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
        errorLocal: { bytes: 0 }
      }
    })
    expect(Object.hasOwn(page.rows[0].small, 'syncMap')).toBe(false)
    const sourceIdentity = f.source.storage.getSettings().storageIdentityKey,
      managedPage = await f.manager.readJournalFieldProvenance(sourceIdentity, { checkpoint: state })
    expect(managedPage.checkpoint).toEqual(state)
    expect(managedPage.page).toEqual(page)
    await expect(
      f.manager.readJournalFieldProvenance(sourceIdentity, { checkpoint: { ...state, sequence: state.sequence + 1 } })
    ).rejects.toThrow('actual completed window')
    reader = await f.manager.openJournalProvenanceField(sourceIdentity, incomingId, 'syncMap', { checkpoint: state })
    const result = Buffer.alloc(bytes.length)
    try {
      for (let offset = 0; offset < bytes.length; offset += 16001) {
        const chunk = await reader.read(offset, Math.min(16001, bytes.length - offset))
        try {
          result.set(chunk, offset)
        } finally {
          chunk.fill(0)
        }
      }
      expect(result).toEqual(bytes)
      expect(await reader.read(bytes.length, 0)).toHaveLength(0)
      await expect(reader.read(0, 16385)).rejects.toThrow()
      await expect(reader.read.call({} as SnapshotJournalProvenanceFieldReader, 0, 1)).rejects.toThrow()
    } finally {
      result.fill(0)
    }
    const header = await f.target
        .knex('snapshot_reconciliation_pf_versions')
        .where({ incomingId, fieldName: 'syncMap', linked: 1 })
        .first(),
      original = await f.target
        .knex('snapshot_reconciliation_pf_chunks')
        .where({ versionId: header.versionId, byteOffset: 0 })
        .first(),
      changed = Buffer.from(original.payload)
    changed[0] ^= 1
    await f.target
      .knex('snapshot_reconciliation_pf_chunks')
      .where({ versionId: header.versionId, byteOffset: 0 })
      .update({ payload: changed, sha256: createHash('sha256').update(changed).digest('hex') })
    await expect(reader.read(0, 1)).rejects.toThrow()
    await expect(
      SnapshotJournalProvenanceFieldReader.open(
        f.target,
        begun.destination.binding,
        state,
        incomingId,
        'syncMap',
        f.admission
      )
    ).rejects.toThrow()
    await f.target
      .knex('snapshot_reconciliation_pf_chunks')
      .where({ versionId: header.versionId, byteOffset: 0 })
      .update({ payload: original.payload, sha256: original.sha256 })
    await expect(reader.read(0, 1)).rejects.toThrow()
    reader.close()
    reader = await SnapshotJournalProvenanceFieldReader.open(
      f.target,
      begun.destination.binding,
      state,
      incomingId,
      'syncMap',
      f.admission
    )
    expect(await reader.read(16380, 32)).toEqual(bytes.subarray(16380, 16412))
    let cleanup = await begun.destination.cleanup(state)
    while (!cleanup.complete) cleanup = await begun.destination.cleanup(state)
    expect((await f.target.knex('snapshot_reconciliation_pf_budgets').first()).reserved).toBe(bytes.length)
    expect(await reader.read(0, 4)).toEqual(bytes.subarray(0, 4))
    const previous = archive.manifest.binding.journal.receipt
    await f.source.storage.knex('sync_states').where('syncStateId', incomingId).delete()
    archive = await f.client.openSnapshotJournalFieldArchive(f.source.identityKey, {
      binding: previous.binding,
      highWater: previous.highWater
    })
    if (archive === undefined) throw new Error('Actual incremental provenance artifact unavailable')
    const next = await KnexSnapshotJournalFieldDestination.begin(
      f.target,
      f.source.identityKey,
      archive.manifest.binding,
      journalCopyLimits(),
      f.admission
    )
    let nextState = next.checkpoint
    await expect(reader.read(0, 1)).rejects.toThrow()
    for (let ordinal = 0; ordinal < archive.frameCount; ordinal++)
      nextState = await next.destination.stageArchiveFrame(nextState, archive)
    while (nextState.phase !== 'acknowledged')
      nextState = (await next.destination.promote(nextState, archive)).checkpoint
    const bounded = await read(
      async trx => await cleanupSnapshotJournalAcknowledgedWindow(trx, next.destination.binding, nextState, 1)
    )
    expect(bounded.removed).toBeLessThanOrEqual(1)
    if (await f.target.knex('snapshot_reconciliation_pf_versions').where('versionId', header.versionId).first())
      expect((await f.target.knex('snapshot_reconciliation_pf_budgets').first()).reserved).toBe(bytes.length)
    cleanup = await next.destination.cleanup(nextState)
    while (!cleanup.complete) cleanup = await next.destination.cleanup(nextState)
    expect((await f.target.knex('snapshot_reconciliation_pf_budgets').first()).reserved).toBe(0)
    expect(await f.target.knex('snapshot_reconciliation_pf_versions')).toHaveLength(0)
    expect(await f.target.knex('snapshot_reconciliation_pf_chunks')).toHaveLength(0)
    original.payload.fill(0)
    changed.fill(0)
  } finally {
    captureSpy.mockRestore()
    openSpy.mockRestore()
    restoreWriter()
    reader?.close()
    bytes.fill(0)
    await archive?.close()
    await f.close()
  }
}, 90000)

test('actual field promotion refuses changed captured identity DATA and resumes after exact restoration', async () => {
  const { KnexSnapshotJournalFieldDestination } = await import('./KnexSnapshotJournalFieldDestination')
  const f = await fixture()
  let archive: RemoteSnapshotJournalFieldArchive | undefined
  try {
    const label = await f.source.storage.findOrInsertTxLabel(
      (await f.source.storage.findOrInsertUser(f.source.identityKey)).user.userId,
      'authenticated field identity'
    )
    archive = await f.client.openSnapshotJournalFieldArchive(f.source.identityKey)
    if (archive === undefined) throw new Error('Actual authenticated identity fixture unavailable')
    const begun = await KnexSnapshotJournalFieldDestination.begin(
      f.target,
      f.source.identityKey,
      archive.manifest.binding,
      journalCopyLimits(),
      f.admission
    )
    let state = begun.checkpoint
    for (let ordinal = 0; ordinal < archive.frameCount; ordinal++)
      state = await begun.destination.stageArchiveFrame(state, archive)
    const key = { sessionId: state.sessionId, tableId: 3, incomingId: label.txLabelId },
      captured = await f.target.knex('snapshot_reconciliation_captured_identities').where(key).select('naturalIdentity')
    expect(captured).toHaveLength(1)
    const original = captured[0].naturalIdentity
    await f.target
      .knex('snapshot_reconciliation_captured_identities')
      .where(key)
      .update({ naturalIdentity: original === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64) })
    let refused = false
    const deadline = performance.now() + 10000
    while (!refused && state.phase !== 'acknowledged') {
      if (performance.now() >= deadline) throw new Error('Actual identity refusal exceeded its bounded fixture phase')
      try {
        state = (await begun.destination.promote(state, archive)).checkpoint
      } catch (cause) {
        expect(cause).toBeInstanceOf(Error)
        expect((cause as Error).message).toContain('captured journal identity')
        refused = true
      }
    }
    expect(refused).toBe(true)
    expect((await begun.destination.status()).checkpoint).toEqual(state)
    expect(await f.target.findTxLabels({ partial: { label: 'authenticated field identity' } })).toHaveLength(0)
    expect(await f.target.knex('snapshot_sync_journal_data_receipts').where('complete', 1)).toHaveLength(0)
    await f.target.knex('snapshot_reconciliation_captured_identities').where(key).update({ naturalIdentity: original })
    while (state.phase !== 'acknowledged') {
      if (performance.now() >= deadline)
        throw new Error('Actual restored field promotion exceeded its bounded fixture phase')
      state = (await begun.destination.promote(state, archive)).checkpoint
    }
    expect(await f.target.findTxLabels({ partial: { label: 'authenticated field identity' } })).toHaveLength(1)
    expect((await begun.destination.status()).checkpoint).toEqual(state)
  } finally {
    await archive?.close()
    await f.close()
  }
})

test('ordinary SQL field reuse rehashes actual indexed target bytes and downloads a changed field through the authentic source', async () => {
  const { KnexSnapshotJournalFieldDestination } = await import('./KnexSnapshotJournalFieldDestination'),
    f = await fixture(),
    script = [0x6a, 0x4e, 0x70, 0x11, 0x01, 0x00, ...Array.from({ length: 70000 }, (_v, at) => at % 251)],
    tx = new Transaction(1, [], [{ satoshis: 1, lockingScript: LockingScript.fromBinary(script) }], 0),
    raw = Buffer.from(tx.toBinary()),
    originalPage = SnapshotJournalFieldArchiveTransport.prototype.page,
    rawHash = createHash('sha256').update(raw).digest('hex'),
    changedDescription = 'actual newer source field 雪\u0000',
    changedHash = createHash('sha256').update(changedDescription, 'utf8').digest('hex')
  let archive: RemoteSnapshotJournalFieldArchive | undefined,
    observe = false,
    rawReads = 0,
    changedReads = 0
  const page = jest.spyOn(SnapshotJournalFieldArchiveTransport.prototype, 'page').mockImplementation(async function (
    this: SnapshotJournalFieldArchiveTransport,
    ...args
  ) {
    const digest = args[1].receipts[args[2]]?.content?.descriptor.sha256
    if (observe && digest === rawHash) rawReads++
    if (observe && digest === changedHash) changedReads++
    return await Reflect.apply(originalPage, this, args)
  })
  const copyFields = async (position?: import('./SnapshotJournalReceiptData').SnapshotJournalArchivePosition) => {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(new Error('Owned field reuse phase expired')), 180000)
    try {
      archive = await f.client.openSnapshotJournalFieldArchive(f.source.identityKey, position, {
        lifetimeMs: 180000,
        signal: controller.signal
      })
      if (archive === undefined) throw new Error('Actual field reuse artifact unavailable')
      const opened = await KnexSnapshotJournalFieldDestination.begin(
        f.target,
        f.source.identityKey,
        archive.manifest.binding,
        journalCopyLimits(),
        f.admission,
        controller.signal
      )
      let state = opened.checkpoint
      for (let ordinal = 0; ordinal < archive.frameCount; ordinal++)
        state = await opened.destination.stageArchiveFrame(state, archive)
      while (state.phase !== 'acknowledged') state = (await opened.destination.promote(state, archive)).checkpoint
      return archive.manifest.binding.journal.receipt
    } finally {
      clearTimeout(timer)
      await archive?.close()
      await archive?.closed
    }
  }
  try {
    const sourceUser = (await f.source.storage.findOrInsertUser(f.source.identityKey)).user.userId,
      stamp = Date.now()
    await f.source.storage.knex('transactions').insert({
      created_at: stamp,
      updated_at: stamp,
      transactionId: 11,
      userId: sourceUser,
      status: 'unprocessed',
      reference: 'ordinary-field-cache',
      isOutgoing: 0,
      satoshis: 1,
      txid: tx.id('hex'),
      version: 1,
      lockTime: 0,
      description: 'original source field',
      rawTx: raw
    })
    const receipt = await copyFields()
    const actual = await f.target.knex('transactions').where('txid', tx.id('hex')).first()
    expect(actual.rawTx).toEqual(raw)
    await f.source.storage
      .knex('transactions')
      .where('transactionId', 11)
      .update({ description: changedDescription, updated_at: stamp + 1000 })
    observe = true
    await copyFields({ binding: receipt.binding, highWater: receipt.highWater })
    expect(rawReads).toBe(0)
    expect(changedReads).toBeGreaterThan(0)
    expect(await f.target.knex('transactions').where('transactionId', actual.transactionId).first()).toMatchObject({
      rawTx: raw,
      description: changedDescription
    })
    expect((await f.target.findOrInsertUser(f.source.identityKey)).user.activeStorage).toBe('journal-data-target')
    expect(await f.source.storage.knex('snapshot_archive_owners')).toHaveLength(0)
  } finally {
    observe = false
    await archive?.close()
    await f.close()
    page.mockRestore()
    raw.fill(0)
    script.fill(0)
  }
}, 400000)

test('retired actual source refuses an old DATA receiver and fresh BEGIN without advancing intake', async () => {
  const f = await fixture()
  let archive: RemoteSnapshotJournalArchive | undefined
  try {
    archive = await f.client.openSnapshotJournalArchive(f.source.identityKey)
    if (archive === undefined) throw new Error('Actual archive unavailable')
    const begun = await KnexSnapshotJournalDataDestination.begin(
      f.target,
      f.source.identityKey,
      archive.manifest.binding,
      journalCopyLimits(),
      f.admission
    )
    const { user } = await f.target.findOrInsertUser(f.source.identityKey)
    const control = await f.target.getPrimaryHandoffControl()
    if (control === undefined) throw new Error('Actual control unavailable')
    const auth = { userId: user.userId, identityKey: f.source.identityKey },
      operationId = 'ab'.repeat(16)
    const prepared = await control.prepareSource(auth, operationId, 'next-primary')
    await control.retireSource(auth, {
      version: 1,
      operationId,
      targetStorageIdentityKey: 'next-primary',
      sources: [prepared]
    })
    const frame = await archive.readFrame(0, async () => {})
    await expect(
      begun.destination.stagePacket(
        begun.checkpoint,
        encodeSnapshotJournalArchiveFrame(snapshotJournalDestinationStreams[0], frame.page)
      )
    ).rejects.toMatchObject({ code: 'WERR_NOT_ACTIVE' })
    await expect(
      KnexSnapshotJournalDataDestination.begin(
        f.target,
        f.source.identityKey,
        archive.manifest.binding,
        journalCopyLimits(),
        f.admission
      )
    ).rejects.toMatchObject({ code: 'WERR_NOT_ACTIVE' })
    expect((await begun.destination.status()).checkpoint).toEqual(begun.checkpoint)
    expect(await f.target.knex('snapshot_reconciliation_stage_pages')).toEqual([])
  } finally {
    await archive?.close()
    await f.close()
  }
})

test('actual final HTTP DATA ACK activates the parked target atomically and survives reply recovery', async () => {
  const f = await fixture()
  let archive: RemoteSnapshotJournalArchive | undefined
  try {
    const { user } = await f.source.storage.findOrInsertUser(f.source.identityKey)
    await f.source.storage.findOrInsertTxLabel(user.userId, 'actual cold wallet primary handoff label')
    const { user: targetUser } = await f.target.findOrInsertUser(f.source.identityKey)
    const sourceControl = await f.source.storage.getPrimaryHandoffControl(),
      targetControl = await f.target.getPrimaryHandoffControl()
    if (sourceControl === undefined || targetControl === undefined)
      throw new Error('Actual primary control unavailable')
    const auth = { userId: user.userId, identityKey: f.source.identityKey },
      targetAuth = { userId: targetUser.userId, identityKey: f.source.identityKey }
    const operationId = 'cd'.repeat(16),
      targetStorageIdentityKey = f.target.getSettings().storageIdentityKey
    const prepared = await sourceControl.prepareSource(auth, operationId, targetStorageIdentityKey)
    const plan = { version: 1 as const, operationId, targetStorageIdentityKey, sources: [prepared] }
    await targetControl.prepareTarget(targetAuth, plan)
    // A genuine complete pre-retirement copy is still insufficient.
    archive = await f.client.openSnapshotJournalArchive(f.source.identityKey)
    if (archive === undefined) throw new Error('Actual pre-retirement archive unavailable')
    const warm = await KnexSnapshotJournalDataDestination.begin(
      f.target,
      f.source.identityKey,
      archive.manifest.binding,
      journalCopyLimits(),
      f.admission
    )
    await copy(archive, warm.destination, warm.checkpoint)
    await expect(targetControl.activateTarget(targetAuth, plan)).rejects.toThrow('actual completed')
    await archive.close()
    archive = undefined
    await sourceControl.retireSource(auth, plan)
    archive = await f.client.openSnapshotJournalArchive(f.source.identityKey)
    if (archive === undefined) throw new Error('Actual final archive unavailable')
    const final = await KnexSnapshotJournalDataDestination.begin(
      f.target,
      f.source.identityKey,
      archive.manifest.binding,
      journalCopyLimits(),
      f.admission
    )
    const checkpoint = await copy(archive, final.destination, final.checkpoint)
    expect(checkpoint.phase).toBe('acknowledged')
    expect((await targetControl.status(targetAuth))?.phase).toBe('prepared')
    const before = await f.target.knex('transactions').count({ n: '*' }).first()
    const activated = await targetControl.activateTarget(targetAuth, plan)
    expect(activated).toMatchObject({ side: 'target', phase: 'activated', localEpoch: '2' })
    const replacement = await f.target.getPrimaryHandoffControl()
    expect(await replacement?.activateTarget(targetAuth, plan)).toEqual(activated)
    await expect(f.target.activeWriteTransaction(targetAuth)).resolves.toBeDefined()
    await expect(f.source.storage.activeWriteTransaction(auth)).rejects.toMatchObject({ code: 'WERR_NOT_ACTIVE' })
    expect(await f.target.knex('transactions').count({ n: '*' }).first()).toEqual(before)
    expect((await sourceControl.completeSource(auth, plan)).phase).toBe('complete')
    expect((await targetControl.completeTarget(targetAuth, plan)).phase).toBe('complete')
    await expect(sourceControl.cancel(auth, operationId)).rejects.toThrow('recover forward')
  } finally {
    await archive?.close()
    await f.close()
  }
})

test('authenticated primary control RPC resolves the actual profile and refuses forged role or copy authority', async () => {
  const f = await fixture()
  try {
    const control = await f.client.getPrimaryHandoffControl()
    if (control === undefined) throw new Error('Actual authenticated control unavailable')
    const auth = { identityKey: f.source.identityKey, userId: 999999, isActive: false }
    expect(await control.status(auth)).toBeUndefined()
    const id = 'ef'.repeat(16),
      target = f.target.getSettings().storageIdentityKey
    const prepared = await control.prepareSource(auth, id, target)
    expect(prepared.storageIdentityKey).toBe(f.source.storage.getSettings().storageIdentityKey)
    expect((await control.status(auth))?.phase).toBe('prepared')
    await expect(control.status({ ...auth, identityKey: '02' + '33'.repeat(32) })).rejects.toMatchObject({
      code: 'WERR_UNAUTHORIZED'
    })
    await expect(control.prepareSource(auth, 'ab'.repeat(16), target)).rejects.toThrow('conflicts')
    await expect(
      control.prepareTarget(auth, {
        version: 1,
        operationId: id,
        targetStorageIdentityKey: prepared.storageIdentityKey,
        sources: [{ storageIdentityKey: 'fake-source', epoch: '0' }]
      })
    ).rejects.toThrow()
    await expect(
      control.activateTarget(auth, {
        version: 1,
        operationId: id,
        targetStorageIdentityKey: prepared.storageIdentityKey,
        sources: [{ storageIdentityKey: 'fake-source', epoch: '0' }]
      })
    ).rejects.toThrow()
    expect((await control.cancel(auth, id)).phase).toBe('cancelled')
  } finally {
    await f.close()
  }
})

test('wallet manager completes an authenticated HTTP primary handoff in both directions with real destination ACKs', async () => {
  const f = await fixture()
  try {
    const remoteUser = (await f.source.storage.findOrInsertUser(f.source.identityKey)).user
    const targetUser = (await f.target.findOrInsertUser(f.source.identityKey)).user
    await f.source.storage.findOrInsertTxLabel(remoteUser.userId, 'actual HTTP source metadata')
    await f.target.findOrInsertTxLabel(targetUser.userId, 'actual original target metadata')
    const manager = new WalletStorageManager(f.source.identityKey, f.client, [f.target])
    await manager.makeAvailable()
    const targetKey = f.target.getSettings().storageIdentityKey
    await manager.setActive(targetKey)
    expect(manager.getActive()).toBe(f.target)
    expect(manager.isActiveEnabled).toBe(true)
    expect(await f.target.findTxLabels({ partial: { label: 'actual HTTP source metadata' } })).toHaveLength(1)
    expect(await f.source.storage.findTxLabels({ partial: { label: 'actual original target metadata' } })).toHaveLength(
      1
    )
    const remoteKey = f.source.storage.getSettings().storageIdentityKey
    await manager.setActive(remoteKey)
    expect(manager.getActive()).toBe(f.client)
    expect(manager.isActiveEnabled).toBe(true)
    expect((await manager.getAuth(true)).isActive).toBe(true)
    for (const storage of [f.source.storage, f.target]) {
      expect((await storage.findOrInsertUser(f.source.identityKey)).user.activeStorage).toBe(remoteKey)
      expect(await storage.findTxLabels({ partial: { label: 'actual HTTP source metadata' } })).toHaveLength(1)
      expect(await storage.findTxLabels({ partial: { label: 'actual original target metadata' } })).toHaveLength(1)
    }
  } finally {
    await f.close()
  }
}, 120000)

test('mobile client negotiates the same authenticated durable control without exposing SQL capabilities', async () => {
  const f = await fixture()
  try {
    const { url } = await f.source.serve()
    const client = new StorageMobile(f.source.wallet, url, { serverIdentityKey: f.source.serverIdentityKey })
    const control = await client.getPrimaryHandoffControl()
    if (control === undefined) throw new Error('Actual mobile control unavailable')
    const auth = { identityKey: f.source.identityKey, userId: 999999, isActive: true },
      id = '01'.repeat(16)
    const prepared = await control.prepareSource(auth, id, 'mobile-target')
    expect(prepared.storageIdentityKey).toBe(f.source.storage.getSettings().storageIdentityKey)
    expect((await control.status(auth))?.operationId).toBe(id)
    expect((await control.cancel(auth, id)).phase).toBe('cancelled')
  } finally {
    await f.close()
  }
})

test('a control HTTP deadline recovers actual committed retirement without reactivating its source', async () => {
  const f = await fixture()
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => {
      release = resolve
    }),
    reached = new Promise<void>(resolve => {
      entered = resolve
    })
  let pending: Promise<unknown> | undefined,
    reachedActual = false
  const original = f.source.storage.getPrimaryHandoffControl.bind(f.source.storage)
  try {
    jest.spyOn(f.source.storage, 'getPrimaryHandoffControl').mockImplementation(async (...options) => {
      const control = await original(...options)
      if (control === undefined) return undefined
      return {
        ...control,
        retireSource: async (...args) => {
          const status = await control.retireSource(...args)
          reachedActual = true
          entered()
          await gate
          return status
        }
      }
    })
    const { url } = await f.source.serve()
    const client = new StorageClient(f.source.wallet, url, {
      serverIdentityKey: f.source.serverIdentityKey,
      primaryHandoffRequestTimeoutMs: 1000
    })
    await client.makeAvailable()
    const control = await client.getPrimaryHandoffControl()
    if (control === undefined) throw new Error('Actual RPC control unavailable')
    const { user } = await f.source.storage.findOrInsertUser(f.source.identityKey)
    const auth = { identityKey: f.source.identityKey, userId: user.userId },
      operationId = '12'.repeat(16),
      targetStorageIdentityKey = f.target.getSettings().storageIdentityKey
    const old = await f.source.storage.activeWriteTransaction(auth)
    const source = await control.prepareSource(auth, operationId, targetStorageIdentityKey)
    const selected = { version: 1 as const, operationId, targetStorageIdentityKey, sources: [source] }
    pending = control.retireSource(auth, selected)
    await Promise.race([
      reached,
      pending.then(
        () => {
          throw new Error('Actual retirement reply did not pause')
        },
        error => {
          if (!reachedActual) throw error
        }
      )
    ])
    await expect(pending).rejects.toBeInstanceOf(Error)
    const actual = await original()
    expect((await actual?.status(auth))?.phase).toBe('retired')
    await expect(old.assertCurrent()).rejects.toMatchObject({ code: 'WERR_NOT_ACTIVE' })
    release()
    expect((await control.status(auth))?.phase).toBe('retired')
  } finally {
    release()
    await pending?.catch(() => undefined)
    await f.close()
  }
})
