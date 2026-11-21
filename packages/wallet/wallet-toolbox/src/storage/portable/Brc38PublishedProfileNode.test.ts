import { mkdtemp, rm, readdir, lstat, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createKnex from 'knex'
import { previewPrivateFixture, previewDestinationFixture, previewReceiptPolicy } from './Brc38ImportPreviewFixture'
import { restoreProofFixture, restorePortableProof } from '../../../test/utils/Brc38ImportEntityRestoreFixture'
import { Brc38PrivateNativeRestoreNode } from './Brc38PrivateNativeRestoreNode'
import { Brc38PublishedProfileNode } from './Brc38PublishedProfileNode'
import { WalletStorageManager } from '../WalletStorageManager'
import { runInSeries } from '../../utility/runInSeries'
import { spawn } from 'node:child_process'
import { captureBrc38ProfilePhysicalIdentity } from './Brc38ProfilePhysicalIdentityNode'
import * as physicalIdentity from './Brc38ProfilePhysicalIdentityNode'
import { createHash } from 'node:crypto'

const tables = [
  'users',
  'proven_txs',
  'output_baskets',
  'output_tags',
  'tx_labels',
  'transactions',
  'outputs',
  'tx_labels_map',
  'output_tags_map',
  'certificates',
  'certificate_fields',
  'commissions',
  'proven_tx_reqs',
  'sync_states',
  'brc38_import_original'
]
describe('actual durable single-profile publication and explicit native activation', () => {
  let cleanup: Array<() => Promise<void>>
  beforeEach(() => {
    cleanup = []
  })
  afterEach(async () => {
    const results = await Promise.allSettled(cleanup.map(close => close()))
    const errors = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, 'Published profile fixture cleanup failed')
  })
  async function fixture(complete = true) {
    const proof = restoreProofFixture(),
      parent = await mkdtemp(join(tmpdir(), 'brc38-published-'))
    const staged = await previewPrivateFixture(undefined, data => restorePortableProof(data, proof), 2097152, 8388608)
    const opened: Brc38PublishedProfileNode[] = []
    cleanup.push(async () => {
      await runInSeries(opened, async profile => await profile.close())
      await staged.close()
      await rm(parent, { recursive: true, force: true })
    })
    const restore = await Brc38PrivateNativeRestoreNode.open(staged.value.reservation.store, {
      receiptPolicy: previewReceiptPolicy,
      maximumStepRows: 16,
      maximumStepBytes: 2097152,
      maximumMappedIds: 1000,
      maximumJournalLogicalBytes: 516096,
      services: proof.services
    })
    if (complete) await finish(restore)
    return { proof, parent, staged, restore, opened }
  }
  async function finish(restore: Brc38PrivateNativeRestoreNode): Promise<void> {
    await runInSeries(
      Array.from({ length: 14 }, (_, index) => index),
      async fromRow => {
        expect(await restore.step(fromRow)).toMatchObject({ nextRow: fromRow + 1 })
      }
    )
    expect(await restore.status()).toMatchObject({ state: 'COMPLETE', nextRow: 14 })
  }
  async function database(directory: string) {
    const db = createKnex({
      client: 'better-sqlite3',
      connection: { filename: join(directory, 'wallet.sqlite') },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
    cleanup.push(async () => await db.destroy())
    return db
  }
  test('copy preserves all native tables and originals, activation affects only the selected profile, and durable reopen survives the import expiry', async () => {
    const { proof, parent, staged, restore, opened } = await fixture()
    const source = staged.value.reservation.store,
      expected = new Map<string, unknown>()
    await runInSeries(tables, async table => expected.set(table, await source.knex(table)))
    const active = await previewDestinationFixture()
    cleanup.push(async () => await active.close())
    await active.storage.insertUser({
      userId: 7,
      identityKey: 'original-identity',
      activeStorage: 'synthetic target',
      created_at: new Date(0),
      updated_at: new Date(0)
    })
    const activeManager = new WalletStorageManager('original-identity', active.storage)
    await activeManager.makeAvailable()
    const activeUsers = await active.k('users'),
      sourceUsage = await staged.root.usage()
    const profile = await restore.publish(parent)
    opened.push(profile)
    const catalog = createKnex({
      client: 'better-sqlite3',
      connection: { filename: join(profile.directory, 'profile.sqlite') },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
    cleanup.push(async () => await catalog.destroy())
    const durable = JSON.parse((await catalog('profile').where({ slot: 1 }).first()).fixedJson)
    expect(durable.protocol).toBe('brc38-published-profile/v2')
    expect(durable.physicalIdentity).toEqual(await captureBrc38ProfilePhysicalIdentity(profile.directory, true))
    await catalog.destroy()
    expect(await profile.status()).toMatchObject({
      state: 'READY',
      bindingSha256: source.binding!.digest,
      reservedPhysicalBytes: source.limits.maximumPhysicalBytes
    })
    expect(await staged.root.usage()).toEqual(sourceUsage)
    await expect(restore.status()).rejects.toThrow('unavailable')
    await expect(
      staged.root.resume(staged.value.reservation.id, staged.selected.limits, staged.selected.binding)
    ).rejects.toThrow()
    const copied = await database(profile.directory)
    await runInSeries(tables, async table => expect(await copied(table)).toEqual(expected.get(table)))
    expect((await copied('users').first()).activeStorage).toBe('')
    expect(await active.k('users')).toEqual(activeUsers)
    const selected = await profile.activate(proof.services)
    expect(selected.isActiveEnabled).toBe(true)
    expect((await selected.getAuth(true)).identityKey).toBe('original-identity')
    expect(selected.getActive()).not.toBe(active.storage)
    expect(await active.k('users')).toEqual(activeUsers)
    expect(activeManager.getActive()).toBe(active.storage)
    expect((await copied('users').first()).activeStorage).toBe(staged.selected.binding.targetStorageIdentityKey)
    expect(await captureBrc38ProfilePhysicalIdentity(profile.directory, true)).toEqual(durable.physicalIdentity)
    expect((await copied.raw('PRAGMA journal_mode'))[0].journal_mode).toBe('delete')
    expect(await copied('brc38_import_original')).toEqual(expected.get('brc38_import_original'))
    await copied.destroy()
    await restore.discard(
      staged.root,
      staged.value.reservation.id,
      new Error('Durable independent profile acknowledged')
    )
    expect(await staged.root.usage()).toEqual({
      imports: 0,
      logicalBytes: 0,
      physicalBytes: 3145728
    })
    await expect(lstat(source.directory)).rejects.toMatchObject({ code: 'ENOENT' })
    await profile.close()
    await restore.close()
    const now = jest.spyOn(Date, 'now').mockReturnValue(source.limits.expiresAt + 1)
    try {
      const recovered = await Brc38PublishedProfileNode.open(profile.directory, source.binding!.digest)
      opened.push(recovered)
      expect(await recovered.status()).toMatchObject({ state: 'ACTIVE' })
      expect(await captureBrc38ProfilePhysicalIdentity(recovered.directory, true)).toEqual(durable.physicalIdentity)
      expect((await recovered.activate(proof.services)).isActiveEnabled).toBe(true)
      expect(await active.k('users')).toEqual(activeUsers)
    } finally {
      now.mockRestore()
    }
  })
  test('fresh publication and READY reopen verify the opened descriptor against the durable wallet receipt before activation', async () => {
    const { proof, parent, staged, restore, opened } = await fixture()
    const check = jest.spyOn(physicalIdentity, 'assertBrc38ProfileFileDescriptor')
    try {
      const profile = await restore.publish(parent)
      opened.push(profile)
      const recorded = await captureBrc38ProfilePhysicalIdentity(profile.directory, true)
      expect(check).toHaveBeenCalled()
      expect(check.mock.calls.map(call => call[1])).toEqual(check.mock.calls.map(() => recorded.wallet))
      check.mockClear()
      await profile.close()
      const recovered = await Brc38PublishedProfileNode.open(
        profile.directory,
        staged.value.reservation.store.binding!.digest
      )
      opened.push(recovered)
      expect(check).toHaveBeenCalled()
      expect(check.mock.calls.map(call => call[1])).toEqual(check.mock.calls.map(() => recorded.wallet))
      check.mockClear()
      const manager = await recovered.activate(proof.services)
      expect(check).toHaveBeenCalled()
      expect(check.mock.calls.map(call => call[1])).toEqual(check.mock.calls.map(() => recorded.wallet))
      expect(manager.isActiveEnabled).toBe(true)
      expect(await captureBrc38ProfilePhysicalIdentity(profile.directory, true)).toEqual(recorded)
    } finally {
      check.mockRestore()
    }
  })
  test('publication rejects incomplete and cancelled work without releasing source capacity or changing its acknowledged prefix', async () => {
    const { parent, staged, restore } = await fixture(false),
      usage = await staged.root.usage(),
      status = await restore.status()
    await expect(restore.publish(parent)).rejects.toThrow('complete native restore')
    expect(await readdir(parent)).toEqual([])
    expect(await staged.root.usage()).toEqual(usage)
    expect(await restore.status()).toEqual(status)
    await finish(restore)
    const cancelled = new AbortController(),
      cause = new Error('synthetic cancelled publication')
    cancelled.abort(cause)
    await expect(restore.publish(parent, cancelled.signal)).rejects.toThrow(cause.message)
    expect(await readdir(parent)).toEqual([])
    expect(await staged.root.usage()).toEqual(usage)
    expect(await restore.status()).toMatchObject({ state: 'COMPLETE' })
  })
  test('an enrollment I/O failure drains the actual new kernel and files before returning the original cause', async () => {
    const { parent, staged, restore } = await fixture(),
      usage = await staged.root.usage()
    const cause = new Error('synthetic physical enrollment I/O failure')
    const enrollment = jest.spyOn(physicalIdentity, 'captureBrc38ProfilePhysicalIdentity').mockRejectedValueOnce(cause)
    try {
      await expect(restore.publish(parent)).rejects.toThrow(cause.message)
    } finally {
      enrollment.mockRestore()
    }
    expect(await readdir(parent)).toEqual([])
    expect(await staged.root.usage()).toEqual(usage)
    expect(await restore.status()).toMatchObject({ state: 'COMPLETE', nextRow: 14 })
  })
  test('the original version-one receipt remains readable without silently enrolling stronger file identity metadata', async () => {
    const { parent, staged, restore, opened } = await fixture(),
      profile = await restore.publish(parent)
    opened.push(profile)
    await profile.close()
    const catalog = createKnex({
      client: 'better-sqlite3',
      connection: { filename: join(profile.directory, 'profile.sqlite') },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
    cleanup.push(async () => await catalog.destroy())
    const row = await catalog('profile').where({ slot: 1 }).first(),
      legacy = JSON.parse(row.fixedJson)
    legacy.protocol = 'brc38-published-profile/v1'
    delete legacy.physicalIdentity
    const json = JSON.stringify(legacy)
    await catalog('profile')
      .where({ slot: 1 })
      .update({ fixedJson: json, fixedSha256: createHash('sha256').update(json).digest('hex') })
    await catalog.destroy()
    const reopened = await Brc38PublishedProfileNode.open(
      profile.directory,
      staged.value.reservation.store.binding!.digest
    )
    opened.push(reopened)
    expect(await reopened.status()).toMatchObject({ state: 'READY' })
    const readback = createKnex({
      client: 'better-sqlite3',
      connection: { filename: join(profile.directory, 'profile.sqlite') },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
    cleanup.push(async () => await readback.destroy())
    expect((await readback('profile').where({ slot: 1 }).first()).fixedJson).toBe(json)
    expect(legacy.admission).toEqual(restore.admission)
    expect(legacy.limits).toEqual(staged.value.reservation.store.limits)
    await readback.destroy()
  })
  test('kernel ownership excludes another claimant and wrong binding; READY remains inactive after actual handoff', async () => {
    const { parent, staged, restore, opened } = await fixture()
    const profile = await restore.publish(parent)
    opened.push(profile)
    await expect(
      Brc38PublishedProfileNode.open(profile.directory, staged.value.reservation.store.binding!.digest)
    ).rejects.toThrow()
    await expect(profile.discardIncomplete()).rejects.toThrow('incomplete')
    await profile.close()
    await expect(Brc38PublishedProfileNode.open(profile.directory, '0'.repeat(64))).rejects.toThrow('binding')
    const recovered = await Brc38PublishedProfileNode.open(
      profile.directory,
      staged.value.reservation.store.binding!.digest
    )
    opened.push(recovered)
    expect(await recovered.status()).toMatchObject({ state: 'READY' })
    const db = await database(profile.directory)
    expect((await db('users').first()).activeStorage).toBe('')
    expect((await lstat(join(profile.directory, 'wallet.sqlite'))).mode & 0o777).toBe(0o600)
    expect((await lstat(profile.directory)).mode & 0o777).toBe(0o700)
  })
  test('digest corruption is refused before activation and does not silently repair or activate the copied profile', async () => {
    const { parent, staged, restore, opened } = await fixture()
    const profile = await restore.publish(parent)
    opened.push(profile)
    await profile.close()
    const file = await open(join(profile.directory, 'wallet.sqlite'), 'r+')
    try {
      await file.write(Buffer.from([99]), 0, 1, 150)
      await file.sync()
    } finally {
      await file.close()
    }
    await expect(
      Brc38PublishedProfileNode.open(profile.directory, staged.value.reservation.store.binding!.digest)
    ).rejects.toThrow('digest')
  })
  test('an actual native primary commit with a lost activation acknowledgement reopens ACTIVATING and completes idempotently', async () => {
    const { parent, staged, restore, opened, proof } = await fixture()
    const profile = await restore.publish(parent)
    opened.push(profile)
    const nativeSetActive = WalletStorageManager.prototype.setActive,
      cause = new Error('synthetic activation acknowledgement loss')
    const failure = jest.spyOn(WalletStorageManager.prototype, 'setActive').mockImplementationOnce(async function (
      this: WalletStorageManager,
      ...args
    ) {
      await nativeSetActive.apply(this, args)
      throw cause
    })
    try {
      await expect(profile.activate(proof.services)).rejects.toThrow(cause.message)
    } finally {
      failure.mockRestore()
    }
    expect(await profile.status()).toMatchObject({ state: 'ACTIVATING' })
    await profile.close()
    const recovered = await Brc38PublishedProfileNode.open(
      profile.directory,
      staged.value.reservation.store.binding!.digest
    )
    opened.push(recovered)
    const manager = await recovered.activate(proof.services)
    expect(manager.isActiveEnabled).toBe(true)
    expect(await recovered.status()).toMatchObject({ state: 'ACTIVE' })
    expect(await recovered.activate(proof.services)).toBe(manager)
  })
  test('controlled process exit after the actual durable file copy leaves RECEIVING unservable and physically reclaimable without releasing the original source charge', async () => {
    const { parent, staged, restore, opened, proof } = await fixture()
    const usage = await staged.root.usage(),
      original = restore.admission,
      expectedOriginals = await staged.value.reservation.store.knex('brc38_import_original')
    await restore.close()
    const script = `
      const {Brc38StagingAdmissionNode} = require(process.argv[1] + '/Brc38StagingAdmissionNode.js')
      const {Brc38PublishedProfileNode} = require(process.argv[1] + '/Brc38PublishedProfileNode.js')
      const data = JSON.parse(process.argv[2])
      ;(async () => {
        const root = await Brc38StagingAdmissionNode.reopen(data.source, data.capacity)
        const claimed = await root.resume(data.id, data.limits, data.binding)
        const copy = claimed.store.copyCompletedNativeRestore.bind(claimed.store)
        claimed.store.copyCompletedNativeRestore = async (...args) => {
          const result = await copy(...args)
          process.send({directory: require('node:path').dirname(args[0])})
          setInterval(() => {}, 1000)
          await new Promise(() => {})
          return result
        }
        await Brc38PublishedProfileNode.publish(data.parent, claimed.store, data.admission)
      })().catch(error => {process.stderr.write(String(error)); process.exitCode = 1})
    `
    const args = {
      source: staged.directory,
      capacity: { maximumImports: 1, maximumPhysicalBytes: 11534336, maximumLogicalBytes: 1048576 },
      id: staged.value.reservation.id,
      limits: staged.selected.limits,
      binding: staged.selected.binding,
      parent,
      admission: original
    }
    const child = spawn(
      process.execPath,
      ['-e', script, join(__dirname, '../../../out/src/storage/portable'), JSON.stringify(args)],
      {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc']
      }
    )
    let errorText = ''
    child.stderr?.on('data', (value: Buffer) => {
      errorText = (errorText + value.toString()).slice(0, 4096)
    })
    const exited = new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', () => resolve())
    })
    let directory = ''
    try {
      directory = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Controlled copy fixture did not reach the durable boundary: ' + errorText)),
          10000
        )
        child.once('message', message => {
          clearTimeout(timeout)
          resolve((message as { directory: string }).directory)
        })
        child.once('exit', () => {
          clearTimeout(timeout)
          reject(new Error('Controlled copy fixture exited early: ' + errorText))
        })
        child.once('error', cause => {
          clearTimeout(timeout)
          reject(cause)
        })
      })
    } finally {
      child.kill('SIGKILL')
      await exited
    }
    expect(child.signalCode).toBe('SIGKILL')
    const incomplete = await Brc38PublishedProfileNode.open(directory, staged.value.reservation.store.binding!.digest)
    opened.push(incomplete)
    expect(await incomplete.status()).toMatchObject({ state: 'RECEIVING' })
    await expect(incomplete.activate(proof.services)).rejects.toThrow('Incomplete')
    expect(await staged.root.usage()).toEqual(usage)
    const resumed = await staged.root.resume(
      staged.value.reservation.id,
      staged.selected.limits,
      staged.selected.binding
    )
    staged.held.push(resumed)
    const db = await database(directory)
    expect((await db('users').first()).activeStorage).toBe('')
    expect(await db('brc38_import_original')).toEqual(expectedOriginals)
    await db.destroy()
    await incomplete.discardIncomplete()
    await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await staged.root.usage()).toEqual(usage)
  })
})
