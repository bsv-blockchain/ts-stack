import fc from 'fast-check'
import { appendFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import {
  previewDestinationFixture,
  previewPrivateFixture,
  previewReceiptPolicy as policy
} from './Brc38ImportPreviewFixture'
import {
  decodeBrc38PrivateImportPreview,
  previewBrc38PrivateImport,
  readBrc38PrivateImportPreview,
  withBrc38PrivateImportPreview
} from './Brc38PrivateImportPreviewNode'
import type { Brc38StagingReservation } from './Brc38StagingAdmissionNode'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(
    MIN_PROPERTY_RUNS,
    Number(process.env.FAST_CHECK_NUM_RUNS ?? process.env.FC_NUM_RUNS ?? MIN_PROPERTY_RUNS)
  ),
  seed: Number(process.env.FAST_CHECK_SEED ?? process.env.FC_SEED ?? 3242026)
})
const controls = {
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true,
  path: process.env.FAST_CHECK_PATH ?? process.env.FC_PATH ?? ''
}
const text = fc
  .array(fc.constantFrom('x', 'é', '中', '😀', '"', '\\', '\n'), {
    minLength: 1,
    maxLength: 16
  })
  .map(parts => parts.join(''))
let target: Awaited<ReturnType<typeof previewDestinationFixture>>,
  staged: Awaited<ReturnType<typeof previewPrivateFixture>>,
  reservation: Brc38StagingReservation,
  originalPhysicalReservation: number
let openedTarget = false,
  openedStage = false
const store = () => reservation.store
const preview = (mode: 'restore' | 'merge' = 'merge') =>
  previewBrc38PrivateImport(store(), target.storage, mode, policy)
const hash = (json: string) => createHash('sha256').update(json).digest('hex')
async function clock() {
  return await target
    .k('snapshot_journal_clock')
    .first(
      'id',
      'enabled',
      'reason',
      target.k.raw('CAST(revision AS TEXT) revision'),
      target.k.raw('CAST(ceiling AS TEXT) ceiling')
    )
}
beforeEach(async () => {
  openedTarget = false
  openedStage = false
  target = await previewDestinationFixture()
  openedTarget = true
  staged = await previewPrivateFixture()
  openedStage = true
  originalPhysicalReservation = (await staged.root.usage()).physicalBytes
  reservation = staged.value.reservation
  if (process.env.TMPDIR === '/work/fixtures') {
    for (const path of [target.directory, staged.directory])
      await appendFile('/work/validation/fixture-record.jsonl', JSON.stringify({ path }) + '\n')
  }
  expect(staged.value.archiveSha256).toBe(staged.selected.binding.archiveSha256)
  expect((await stat(store().directory)).mode & 0o777).toBe(0o700)
  expect((await stat(join(store().directory, 'stage.sqlite'))).mode & 0o777).toBe(0o600)
  expect((await staged.root.usage()).imports).toBe(1)
})
afterEach(async () => {
  const directories = [openedTarget ? target.directory : undefined, openedStage ? staged.directory : undefined].filter(
    (path): path is string => path !== undefined
  )
  try {
    if (openedStage) {
      await staged.root.discard(reservation, new Error('generated preview cleanup'))
      expect(await staged.root.usage()).toEqual({
        imports: 0,
        physicalBytes: originalPhysicalReservation - staged.selected.limits.maximumPhysicalBytes,
        logicalBytes: 0
      })
    }
  } finally {
    try {
      if (openedStage) await staged.close()
    } finally {
      if (openedTarget) await target.close()
    }
  }
  for (const directory of directories) await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('generated real previews preserve physical destination, exact clocks and independent receipt charges; stale UUID cannot take the writer', async () => {
  const path = await realpath(join(target.directory, 'target.sqlite')),
    file = await stat(path, { bigint: true }),
    physical = createHash('sha256')
      .update('snapshot-journal-backend-v1\n')
      .update(JSON.stringify(['sqlite', { path, device: file.dev.toString(), inode: file.ino.toString() }]))
      .digest('hex'),
    originalExpiry = store().limits.expiresAt
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom('restore' as const, 'merge' as const),
      fc.integer({ min: 1, max: 10000 }),
      async (mode, nonce) => {
        const beforeClock = await clock(),
          beforeMeta = await store().knex('metadata').first(),
          old = await store().readImportPreview(),
          oldId = old === undefined ? randomUUID() : decodeBrc38PrivateImportPreview(store(), old).previewId,
          generation = await target.k('snapshot_journal_generation').first(),
          value = await preview(mode),
          json = JSON.stringify(value)
        expect(value.target).toMatchObject({
          identityKey: staged.selected.binding.identityKey,
          targetStorageIdentityKey: staged.selected.binding.targetStorageIdentityKey,
          chain: 'test',
          mode,
          backend: 'SQLite',
          backendSha256: physical,
          epoch: generation.epoch,
          schemaSha256: generation.source,
          revision: beforeClock.revision,
          ceiling: beforeClock.ceiling,
          userId: null,
          activeStorage: null,
          primaryEpoch: null
        })
        expect(value.expiresAt).toBe(originalExpiry)
        expect(value.bindingSha256).toBe(store().binding!.digest)
        expect(value.archiveSha256).toBe(staged.selected.binding.archiveSha256)
        expect(value.previewId).not.toBe(oldId)
        expect(Object.isFrozen(value)).toBe(true)
        expect(Object.isFrozen(value.target)).toBe(true)
        expect(await store().knex('private_import').first()).toEqual({
          slot: 1,
          archiveSha256: value.archiveSha256,
          previewJson: json,
          previewSha256: hash(json)
        })
        const previousCharge = old === undefined ? 0 : Buffer.byteLength(old) + 64
        expect(await store().knex('metadata').first()).toEqual({
          ...beforeMeta,
          logicalBytes: beforeMeta.logicalBytes + Buffer.byteLength(json) + 64 - previousCharge
        })
        expect(await readBrc38PrivateImportPreview(store())).toEqual(value)
        expect(await clock()).toEqual(beforeClock)
        expect(await target.k('users')).toEqual([])
        const writer = await target.writer.transaction()
        try {
          await writer('snapshot_journal_clock')
            .where({ id: 1 })
            .update({ revision: writer.ref('revision') })
          let invoked = false
          await expect(
            withBrc38PrivateImportPreview(store(), target.storage, oldId, policy, async () => {
              invoked = true
              return nonce
            })
          ).rejects.toThrow('superseded')
          expect(invoked).toBe(false)
        } finally {
          await writer.rollback()
        }
        let invoked = 0
        await expect(
          withBrc38PrivateImportPreview(store(), target.storage, value.previewId, policy, async trx => {
            invoked++
            expect(trx.isTransaction).toBe(true)
            return nonce
          })
        ).resolves.toBe(nonce)
        expect(invoked).toBe(1)
        expect(await clock()).toEqual(beforeClock)
      }
    ),
    controls
  )
  // Calibrate the real independent writer once. The driver retains its
  // original five-second busy wait; repeating that wait in every generated
  // stale-UUID case would consume the original test deadline without adding
  // a new UUID or ownership assertion. Every stale case above holds a real
  // writer, and every current-UUID success runs after its physical rollback.
  const current = await readBrc38PrivateImportPreview(store()),
    writer = await target.writer.transaction()
  try {
    await writer('snapshot_journal_clock')
      .where({ id: 1 })
      .update({ revision: writer.ref('revision') })
    await expect(
      withBrc38PrivateImportPreview(store(), target.storage, current.previewId, policy, async () => 1)
    ).rejects.toMatchObject({ code: 'SQLITE_BUSY' })
  } finally {
    await writer.rollback()
  }
}, 180000)

test('generated independent journal writes and primary away-and-back refuse stale previews while retaining authenticated receipts', async () => {
  const { user } = await target.storage.findOrInsertUser(staged.selected.binding.identityKey),
    baskets = await target.storage.findOrInsertOutputBasketsBulk(user.userId, ['generated preview journal']),
    basket = baskets['generated preview journal']
  let turn = 0
  await fc.assert(
    fc.asyncProperty(fc.constantFrom('primary', 'journal'), fc.integer({ min: 1, max: 9999 }), async (kind, nonce) => {
      const value = await preview(),
        beforeClock = await clock(),
        beforeUser = await target.k('users').where({ userId: user.userId }).first(),
        beforeEpoch = await target
          .k('snapshot_sync_primary_epochs')
          .where({ userId: user.userId })
          .first(target.k.raw('CAST(epoch AS TEXT) epoch')),
        beforeMeta = await store().knex('metadata').first()
      if (kind === 'primary') {
        await target
          .writer('users')
          .where({ userId: user.userId })
          .update({ activeStorage: 'independent primary ' + nonce })
        await target.writer('users').where({ userId: user.userId }).update({ activeStorage: beforeUser.activeStorage })
        expect(await target.k('users').where({ userId: user.userId }).first()).toEqual(beforeUser)
        expect(await clock()).toEqual(beforeClock)
        const after = await target
          .k('snapshot_sync_primary_epochs')
          .where({ userId: user.userId })
          .first(target.k.raw('CAST(epoch AS TEXT) epoch'))
        expect(after.epoch).toBe((BigInt(beforeEpoch?.epoch ?? '0') + 2n).toString())
      } else {
        await target
          .writer('output_baskets')
          .where({ userId: user.userId, basketId: basket.basketId })
          .update({ updated_at: 1700000000000 + turn++ * 10000 + nonce })
        expect((await clock()).revision).toBe((BigInt(beforeClock.revision) + 1n).toString())
      }
      let invoked = false
      await expect(
        withBrc38PrivateImportPreview(store(), target.storage, value.previewId, policy, async () => {
          invoked = true
          return nonce
        })
      ).rejects.toThrow('changed after')
      expect(invoked).toBe(false)
      expect(await readBrc38PrivateImportPreview(store())).toEqual(value)
      expect(await store().knex('metadata').first()).toEqual(beforeMeta)
      const fresh = await preview()
      expect(fresh.previewId).not.toBe(value.previewId)
      expect(fresh.expiresAt).toBe(value.expiresAt)
      await expect(
        withBrc38PrivateImportPreview(store(), target.storage, fresh.previewId, policy, async () => nonce)
      ).resolves.toBe(nonce)
    }),
    controls
  )
}, 180000)

test('generated noncanonical or mismatched wire projections never replace the actual authenticated receipt', async () => {
  const value = await preview(),
    json = JSON.stringify(value),
    beforeMeta = await store().knex('metadata').first()
  await fc.assert(
    fc.property(text, fc.integer({ min: 1, max: 10000 }), (extra, nonce) => {
      const decoded = decodeBrc38PrivateImportPreview(store(), json)
      expect(decoded).toEqual(value)
      expect(decoded).not.toBe(value)
      expect(decoded.target).not.toBe(value.target)
      expect(Object.isFrozen(decoded)).toBe(true)
      expect(Object.isFrozen(decoded.target)).toBe(true)
      const top = (change: Record<string, unknown>) => JSON.stringify({ ...value, ...change }),
        targetWire = (change: Record<string, unknown>) => top({ target: { ...value.target, ...change } }),
        invalid = [
          'null',
          '[]',
          JSON.stringify(extra),
          '{',
          ' ' + json,
          json + '\n',
          top({ protocol: 'other/' + extra }),
          top({ previewId: '00000000-0000-3000-8000-000000000000' }),
          top({ bindingSha256: hash(extra) }),
          top({ archiveSha256: hash(extra) }),
          top({ expiresAt: value.expiresAt + nonce }),
          top({ target: null }),
          top({ target: [] }),
          top({ extra }),
          targetWire({ identityKey: '' }),
          targetWire({ identityKey: extra }),
          targetWire({ chain: 'main' }),
          targetWire({ mode: extra }),
          targetWire({ targetStorageIdentityKey: '' }),
          targetWire({ backend: 'MySQL' }),
          targetWire({ backendSha256: extra }),
          targetWire({ schemaVersionSha256: 'A'.repeat(64) }),
          targetWire({ schemaSha256: extra }),
          targetWire({ epoch: '00000000-0000-3000-8000-000000000000' }),
          targetWire({ revision: '-1' }),
          targetWire({ revision: '01' }),
          targetWire({ revision: '9223372036854775808' }),
          targetWire({ ceiling: '0' }),
          targetWire({ userId: 1 }),
          targetWire({ activeStorage: extra }),
          targetWire({
            userId: Number.MAX_SAFE_INTEGER + 1,
            activeStorage: 'x',
            primaryEpoch: '0'
          }),
          targetWire({ userId: 1, activeStorage: 'é'.repeat(257), primaryEpoch: '0' }),
          targetWire({ userId: 1, activeStorage: 'x', primaryEpoch: '01' }),
          targetWire({ extra })
        ]
      for (const wire of invalid) expect(() => decodeBrc38PrivateImportPreview(store(), wire)).toThrow()
    }),
    controls
  )
  expect(await readBrc38PrivateImportPreview(store())).toEqual(value)
  expect(await store().knex('metadata').first()).toEqual(beforeMeta)
}, 180000)

test('generated real step rollback retains both owners and preview; physical handoff keeps the original receipt and deadline', async () => {
  const directory = store().directory,
    originalExpiry = store().limits.expiresAt
  await fc.assert(
    fc.asyncProperty(text, fc.boolean(), fc.integer({ min: 1, max: 3 }), async (details, handoff, rows) => {
      const value = await preview(),
        beforeClock = await clock(),
        beforeMeta = await store().knex('metadata').first(),
        failure = new Error('generated preview rollback ' + details)
      await expect(
        withBrc38PrivateImportPreview(store(), target.storage, value.previewId, policy, async trx => {
          for (let id = 1; id <= rows; id++)
            await trx('monitor_events').insert({
              id,
              created_at: 1700000000000,
              updated_at: 1700000000000,
              event: 'generated preview rollback',
              details
            })
          await expect(store().close()).rejects.toThrow('owned private')
          await expect(preview()).rejects.toThrow('already owned')
          await expect(target.writer('settings').update({ storageName: details })).rejects.toMatchObject({
            code: 'SQLITE_BUSY'
          })
          throw failure
        })
      ).rejects.toBe(failure)
      expect(await target.k('monitor_events')).toEqual([])
      expect(await clock()).toEqual(beforeClock)
      expect(await readBrc38PrivateImportPreview(store())).toEqual(value)
      expect(await store().knex('metadata').first()).toEqual(beforeMeta)
      if (handoff) {
        const file = await stat(join(directory, 'stage.sqlite'))
        await store().close()
        reservation = await staged.root.resume(reservation.id, staged.selected.limits, staged.selected.binding)
        staged.held.push(reservation)
        const reopened = await stat(join(directory, 'stage.sqlite'))
        expect([reopened.dev, reopened.ino]).toEqual([file.dev, file.ino])
        expect(store().limits.expiresAt).toBe(originalExpiry)
        expect(await readBrc38PrivateImportPreview(store())).toEqual(value)
        expect(await store().knex('metadata').first()).toEqual(beforeMeta)
        expect((await staged.root.usage()).imports).toBe(1)
      }
    }),
    controls
  )
}, 180000)
