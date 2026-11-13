import fs from 'node:fs/promises'
import { mkdtemp, mkdir, rm, readdir, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createKnex from 'knex'
import { runInSeries } from '../../utility/runInSeries'
import { previewPrivateFixture, previewReceiptPolicy } from './Brc38ImportPreviewFixture'
import { restoreProofFixture, restorePortableProof } from '../../../test/utils/Brc38ImportEntityRestoreFixture'
import { Brc38PrivateNativeRestoreNode } from './Brc38PrivateNativeRestoreNode'
import { Brc38PublishedProfileNode } from './Brc38PublishedProfileNode'
import { Brc38ProfileInventoryNode } from './Brc38ProfileInventoryNode'

const capacity = { maximumProfiles: 1, maximumPhysicalBytes: 11534336 }
describe('actual durable profile inventory admission, recovery and retirement', () => {
  let cleanup: Array<() => Promise<void>>
  beforeEach(() => {
    cleanup = []
  })
  afterEach(async () => {
    const results = await Promise.allSettled(cleanup.map(close => close()))
    const failures = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
    if (failures.length) throw new AggregateError(failures, 'Profile inventory fixture cleanup remains required')
  })
  async function source() {
    const proof = restoreProofFixture(),
      staged = await previewPrivateFixture(undefined, data => restorePortableProof(data, proof), 2097152, 8388608)
    let closeRestore: (() => Promise<void>) | undefined
    cleanup.push(async () => {
      await closeRestore?.()
      await staged.close()
    })
    const restore = await Brc38PrivateNativeRestoreNode.open(staged.value.reservation.store, {
      receiptPolicy: previewReceiptPolicy,
      maximumStepRows: 16,
      maximumStepBytes: 2097152,
      maximumMappedIds: 1000,
      maximumJournalLogicalBytes: 516096,
      services: proof.services
    })
    closeRestore = async () => await restore.close()
    await runInSeries(
      Array.from({ length: 14 }, (_value, index) => index),
      async fromRow => {
        expect(await restore.step(fromRow)).toMatchObject({ nextRow: fromRow + 1 })
      }
    )
    const store = staged.value.reservation.store,
      admission = restore.admission
    return {
      proof,
      staged,
      restore,
      store,
      admission,
      importId: admission.scope.importId,
      bindingSha256: store.binding!.digest
    }
  }
  async function inventory(selected = capacity) {
    const directory = await mkdtemp(join(tmpdir(), 'brc38-inventory-')),
      root = await Brc38ProfileInventoryNode.create(directory, selected)
    const roots = [root]
    cleanup.push(async () => {
      await runInSeries(roots, async item => await item.close())
      await rm(directory, { recursive: true, force: true })
    })
    async function reopen() {
      const item = await Brc38ProfileInventoryNode.reopen(directory, selected)
      roots.push(item)
      return item
    }
    return { root, directory, reopen }
  }
  async function catalog(directory: string) {
    const db = createKnex({
      client: 'better-sqlite3',
      connection: { filename: join(directory, 'profile-inventory.sqlite') },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
    cleanup.push(async () => await db.destroy())
    return db
  }
  test('actual fixed capacity refuses a second profile before creating files or copying and preserves both source charges', async () => {
    const first = await source(),
      second = await source(),
      { root, directory, reopen } = await inventory(),
      peer = await reopen()
    const firstUsage = await first.staged.root.usage(),
      secondUsage = await second.staged.root.usage()
    const published = await root.publish(first.store, first.admission),
      files = await readdir(directory),
      copier = jest.spyOn(second.store, 'copyCompletedNativeRestore')
    await expect(peer.publish(second.store, second.admission)).rejects.toThrow('capacity exceeded before creation')
    expect(copier).not.toHaveBeenCalled()
    copier.mockRestore()
    expect(await readdir(directory)).toEqual(files)
    expect(await peer.usage()).toEqual({
      profiles: 1,
      published: 1,
      reservedPhysicalBytes: 11534336
    })
    expect(await first.staged.root.usage()).toEqual(firstUsage)
    expect(await second.staged.root.usage()).toEqual(secondUsage)
    expect(await published.status()).toMatchObject({ state: 'READY' })
  })
  test('publication retries return the same owned profile, reject changed original admission, and require an actual catalog acknowledgement for independent activation', async () => {
    const selected = await source(),
      { root, reopen } = await inventory()
    const profile = await root.publish(selected.store, selected.admission)
    expect(await root.publish(selected.store, selected.admission)).toBe(profile)
    await expect(
      root.publish(selected.store, {
        ...selected.admission,
        maximumStepRows: selected.admission.maximumStepRows - 1
      })
    ).rejects.toThrow('original admission')
    const directory = profile.directory
    await profile.close()
    const direct = await Brc38PublishedProfileNode.open(directory, selected.bindingSha256)
    cleanup.push(async () => await direct.close())
    await expect(direct.activate(selected.proof.services)).rejects.toThrow('durable inventory acknowledgement')
    await expect(direct.discardIncomplete()).rejects.toThrow()
    await direct.close()
    const peer = await reopen(),
      recovered = await peer.open(selected.importId, selected.bindingSha256)
    expect(recovered.directory).toBe(directory)
    expect((await recovered.activate(selected.proof.services)).isActiveEnabled).toBe(true)
    expect(await peer.usage()).toEqual({
      profiles: 1,
      published: 1,
      reservedPhysicalBytes: 11534336
    })
  })
  test('the actual native inventory writer is released during source copy while the independent profile claim remains held', async () => {
    const selected = await source(),
      other = await source(),
      { root, reopen } = await inventory(),
      peer = await reopen()
    const copy = selected.store.copyCompletedNativeRestore.bind(selected.store)
    let observed = false
    const held = jest.spyOn(selected.store, 'copyCompletedNativeRestore').mockImplementationOnce(async (...args) => {
      const copied = await copy(...args)
      expect(await peer.usage()).toEqual({
        profiles: 1,
        published: 0,
        reservedPhysicalBytes: 11534336
      })
      await expect(peer.publish(other.store, other.admission)).rejects.toThrow('capacity exceeded before creation')
      await expect(peer.open(selected.importId, selected.bindingSha256)).rejects.toThrow()
      await expect(root.close()).rejects.toThrow('actual profile inventory work')
      observed = true
      return copied
    })
    try {
      await root.publish(selected.store, selected.admission)
    } finally {
      held.mockRestore()
    }
    expect(observed).toBe(true)
    expect(await peer.usage()).toMatchObject({ profiles: 1, published: 1 })
  })
  test('a real READY commit followed by acknowledgement loss recovers the same durable profile after the original deadline without renewing or double charging', async () => {
    const selected = await source(),
      { root, directory, reopen } = await inventory(),
      sourceUsage = await selected.staged.root.usage()
    const copy = Brc38PublishedProfileNode.prototype.copyFromCompletedRestore,
      failure = new Error('synthetic lost inventory acknowledgement')
    const captured: Brc38PublishedProfileNode[] = []
    const lost = jest
      .spyOn(Brc38PublishedProfileNode.prototype, 'copyFromCompletedRestore')
      .mockImplementationOnce(async function (this: Brc38PublishedProfileNode, ...args) {
        captured.push(this)
        await copy.apply(this, args)
        throw failure
      })
    try {
      await expect(root.publish(selected.store, selected.admission)).rejects.toThrow(failure.message)
    } finally {
      lost.mockRestore()
    }
    const profile = captured[0]!
    expect(await profile.status()).toMatchObject({ state: 'READY' })
    await expect(profile.activate(selected.proof.services)).rejects.toThrow('durable inventory acknowledgement')
    expect(await root.usage()).toMatchObject({ profiles: 1, published: 0 })
    const db = await catalog(directory),
      before = await db('profile_inventory').first()
    await db.destroy()
    await root.close()
    const now = jest.spyOn(Date, 'now').mockReturnValue(selected.admission.expiresAt + 1)
    try {
      const peer = await reopen(),
        recovered = await peer.open(selected.importId, selected.bindingSha256)
      expect(recovered.directory).toBe(profile.directory)
      expect(await peer.collect(selected.importId, selected.bindingSha256)).toBe(false)
      expect((await recovered.activate(selected.proof.services)).isActiveEnabled).toBe(true)
      const afterDb = await catalog(directory),
        after = await afterDb('profile_inventory').first()
      expect(after).toEqual({ ...before, state: 'published' })
      await afterDb.destroy()
      expect(await peer.usage()).toEqual({
        profiles: 1,
        published: 1,
        reservedPhysicalBytes: 11534336
      })
      expect(await selected.staged.root.usage()).toEqual(sourceUsage)
    } finally {
      now.mockRestore()
    }
  })
  test('an expired incomplete reservation remains charged while another actual kernel is held and releases only after physical deletion', async () => {
    const selected = await source(),
      { root, directory, reopen } = await inventory(),
      failure = new Error('synthetic pre-copy failure')
    const failed = jest.spyOn(selected.store, 'copyCompletedNativeRestore').mockRejectedValueOnce(failure)
    try {
      await expect(root.publish(selected.store, selected.admission)).rejects.toThrow(failure.message)
    } finally {
      failed.mockRestore()
    }
    const files = (await readdir(directory)).filter(name => name !== 'profile-inventory.sqlite'),
      profilePath = join(directory, files[0]!)
    await expect(root.collect(selected.importId, selected.bindingSha256)).rejects.toThrow('has not expired')
    const peer = await reopen(),
      now = jest.spyOn(Date, 'now').mockReturnValue(selected.admission.expiresAt + 1)
    try {
      await expect(peer.collect(selected.importId, selected.bindingSha256)).rejects.toThrow()
      expect(await peer.usage()).toEqual({
        profiles: 1,
        published: 0,
        reservedPhysicalBytes: 11534336
      })
      expect((await lstat(profilePath)).isDirectory()).toBe(true)
      await root.close()
      expect(await peer.collect(selected.importId, selected.bindingSha256)).toBe(true)
      await expect(lstat(profilePath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(lstat(profilePath + '.retired')).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await peer.usage()).toEqual({
        profiles: 0,
        published: 0,
        reservedPhysicalBytes: 3145728
      })
      expect(await selected.staged.root.usage()).toMatchObject({ imports: 1 })
    } finally {
      now.mockRestore()
    }
  })
  test('an interrupted pre-kernel directory creation retains a durable charge and is reclaimed under the actual inventory writer after expiry', async () => {
    const selected = await source(),
      { root, directory } = await inventory(),
      failure = new Error('synthetic empty directory interruption')
    const preparation = jest.spyOn(Brc38PublishedProfileNode, 'prepareOwnedAt').mockImplementationOnce(async grant => {
      await mkdir(grant.directory, { mode: 0o700 })
      throw failure
    })
    try {
      await expect(root.publish(selected.store, selected.admission)).rejects.toThrow(failure.message)
    } finally {
      preparation.mockRestore()
    }
    expect(await root.usage()).toMatchObject({
      profiles: 1,
      published: 0,
      reservedPhysicalBytes: 11534336
    })
    const now = jest.spyOn(Date, 'now').mockReturnValue(selected.admission.expiresAt + 1)
    try {
      expect(await root.collect(selected.importId, selected.bindingSha256)).toBe(true)
      expect(await readdir(directory)).toEqual(['profile-inventory.sqlite'])
      expect(await root.usage()).toEqual({
        profiles: 0,
        published: 0,
        reservedPhysicalBytes: 3145728
      })
    } finally {
      now.mockRestore()
    }
  })
  test('aggregate physical reservation alone refuses admission even with another profile slot available', async () => {
    const first = await source(),
      second = await source(),
      { root, directory, reopen } = await inventory({ ...capacity, maximumProfiles: 2 })
    await root.publish(first.store, first.admission)
    const before = await readdir(directory),
      peer = await reopen()
    await expect(peer.publish(second.store, second.admission)).rejects.toThrow('capacity exceeded before creation')
    expect(await readdir(directory)).toEqual(before)
    expect(await peer.usage()).toEqual({
      profiles: 1,
      published: 1,
      reservedPhysicalBytes: 11534336
    })
  })
  test.each(['retained native owner', 'fresh native owner'] as const)(
    'actual filesystem cleanup failure retains the charge and tracked retirement for retry with %s',
    async owner => {
      const selected = await source(),
        { root, directory, reopen } = await inventory()
      const failure = jest
        .spyOn(selected.store, 'copyCompletedNativeRestore')
        .mockRejectedValueOnce(new Error('synthetic copy interruption'))
      try {
        await expect(root.publish(selected.store, selected.admission)).rejects.toThrow('copy interruption')
      } finally {
        failure.mockRestore()
      }
      const name = (await readdir(directory)).find(value => value !== 'profile-inventory.sqlite')!,
        retired = join(directory, name + '.retired')
      const actualRm = fs.rm,
        removal = jest.spyOn(fs, 'rm').mockImplementationOnce(async (...args) => {
          await fs.chmod(retired, 0o500)
          return await actualRm(...args)
        })
      const now = jest.spyOn(Date, 'now').mockReturnValue(selected.admission.expiresAt + 1)
      try {
        let cause: unknown
        try {
          await root.collect(selected.importId, selected.bindingSha256)
        } catch (error) {
          cause = error
        }
        expect(['EACCES', 'EPERM']).toContain((cause as NodeJS.ErrnoException).code)
        removal.mockRestore()
        await fs.chmod(retired, 0o700)
        expect(await root.usage()).toEqual({
          profiles: 1,
          published: 0,
          reservedPhysicalBytes: 11534336
        })
        await expect(lstat(join(directory, name))).rejects.toMatchObject({ code: 'ENOENT' })
        expect((await lstat(retired)).isDirectory()).toBe(true)
        let collector = root
        if (owner === 'fresh native owner') {
          await root.close()
          collector = await reopen()
        }
        expect(await collector.collect(selected.importId, selected.bindingSha256)).toBe(true)
        await expect(lstat(retired)).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await collector.usage()).toEqual({
          profiles: 0,
          published: 0,
          reservedPhysicalBytes: 3145728
        })
        expect(await selected.staged.root.usage()).toMatchObject({ imports: 1 })
      } finally {
        removal.mockRestore()
        now.mockRestore()
      }
    }
  )
  test('immutable policy and private native catalog modes survive reopen; cancelled admission creates no profile or charge', async () => {
    const selected = await source(),
      { root, directory } = await inventory(),
      signal = new AbortController()
    signal.abort(new Error('synthetic cancelled inventory admission'))
    await expect(root.publish(selected.store, selected.admission, signal.signal)).rejects.toThrow(
      'cancelled inventory admission'
    )
    expect(await root.usage()).toEqual({
      profiles: 0,
      published: 0,
      reservedPhysicalBytes: 3145728
    })
    expect(await readdir(directory)).toEqual(['profile-inventory.sqlite'])
    expect((await lstat(directory)).mode & 0o777).toBe(0o700)
    expect((await lstat(join(directory, 'profile-inventory.sqlite'))).mode & 0o777).toBe(0o600)
    await expect(Brc38ProfileInventoryNode.reopen(directory, { ...capacity, maximumProfiles: 2 })).rejects.toThrow(
      'original policy'
    )
    const db = await catalog(directory)
    expect((await db.raw('PRAGMA page_size'))[0].page_size).toBe(4096)
    expect((await db.raw('PRAGMA journal_mode'))[0].journal_mode).toBe('delete')
    await db.destroy()
  })
})
