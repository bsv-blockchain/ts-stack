import fc from 'fast-check'
import { appendFile, chmod, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import { stageAuthenticatedBrc39PrivateImport } from './Brc38AuthenticatedPrivateStageNode'
import {
  authenticatedStagePassword,
  encrypted,
  authenticatedStageOptions
} from './Brc38AuthenticatedPrivateStageFixture'
import { Brc38StagingAdmissionNode, type Brc38StagingReservation } from './Brc38StagingAdmissionNode'
import { semanticStageFixture } from './Brc38SemanticStageFixture'
import { brc38StageTables } from './Brc38SemanticStage'
import { brc38PrivateDestinationLease, registerBrc38PrivateDestinationLease } from './Brc38PrivateDestinationLeaseNode'

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

function storage(value: Brc38StagingReservation): StorageKnex {
  return new StorageKnex({
    ...StorageProvider.createStorageBaseOptions(value.store.binding!.binding.chain),
    knex: value.store.knex,
    snapshotSync: false
  })
}
async function fixture(lifetimeMs = 60000) {
  const directory = await mkdtemp(join(tmpdir(), 'brc38-property-private-lease-'))
  await chmod(directory, 0o700)
  if (process.env.TMPDIR === '/work/fixtures')
    await appendFile('/work/validation/fixture-record.jsonl', JSON.stringify({ path: directory }) + '\n')
  const root = await Brc38StagingAdmissionNode.create(directory, {
    maximumImports: 1,
    maximumPhysicalBytes: 7340032,
    maximumLogicalBytes: 1048576
  })
  let value: Brc38StagingReservation | undefined
  try {
    // Original independent legacy fixture uses actual Argon2id and SDK AES-GCM.
    // The production streaming decryptor verifies GCM/digest before parser EOF,
    // semantic seal and the durable authentication receipt. No receipt is forged.
    const bytes = await encrypted(),
      selected = authenticatedStageOptions(bytes)
    selected.limits = { ...selected.limits, expiresAt: Date.now() + lifetimeMs }
    async function* chunks() {
      for (let offset = 0; offset < bytes.length; offset += 137) yield bytes.slice(offset, offset + 137)
    }
    const result = await stageAuthenticatedBrc39PrivateImport(chunks(), authenticatedStagePassword, root, selected)
    value = result.reservation
    expect(result.archiveSha256).toBe(selected.binding.archiveSha256)
    expect(Object.values(result.document.counts).reduce((sum, count) => sum + count, 0)).toBe(13)
    for (const table of brc38StageTables) {
      expect(await value.store.count(table)).toBe(1)
      expect(await value.store.row(table, 0)).toEqual(semanticStageFixture().tables[table][0])
    }
    const expiry = selected.limits.expiresAt
    return {
      directory,
      root,
      value,
      expiry,
      close: async () => {
        await value!.store.close()
        await root.close()
        await rm(directory, { recursive: true, force: true })
      }
    }
  } catch (cause) {
    if (value !== undefined) await value.store.close()
    await root.close()
    await rm(directory, { recursive: true, force: true })
    throw cause
  }
}

describe('actual claimed and authenticated private destination lease lifecycle', () => {
  test('generated wrapper identity never transfers a live lease between independently claimed stores', async () => {
    const first = await fixture(),
      second = await fixture()
    try {
      const action = fc.record({
        index: fc.integer({ min: 0, max: 3 }),
        operation: fc.constantFrom('register-own', 'register-other', 'lookup', 'assert')
      })
      await fc.assert(
        fc.asyncProperty(fc.array(action, { minLength: 1, maxLength: 24 }), async actions => {
          const entries = [first, second, first, second].map(owner => ({
            owner,
            wrapper: storage(owner.value)
          }))
          // Independent bounded model binds wrapper identity, never connection shape.
          const model = new Set<number>()
          const expectedPages = Math.floor((4194304 - 65536) / (3 * 4096))
          for (const { index, operation } of actions) {
            const { owner, wrapper } = entries[index],
              other = owner === first ? second : first
            if (operation === 'register-own') {
              registerBrc38PrivateDestinationLease(wrapper, owner.value.store)
              model.add(index)
            } else if (operation === 'register-other') {
              expect(() => registerBrc38PrivateDestinationLease(wrapper, other.value.store)).toThrow(
                'actual claimed private stage'
              )
            }
            const lease = brc38PrivateDestinationLease(wrapper)
            expect(lease !== undefined).toBe(model.has(index))
            if (lease !== undefined) {
              expect(Object.isFrozen(lease)).toBe(true)
              expect(lease.maximumPages).toBe(expectedPages)
              if (operation === 'assert') lease.assertLive()
            }
            for (let i = 0; i < entries.length; i++)
              expect(brc38PrivateDestinationLease(entries[i].wrapper) !== undefined).toBe(model.has(i))
            expect(owner.value.store.limits.expiresAt).toBe(owner.expiry)
          }
          for (const owner of [first, second]) {
            expect((await owner.value.store.knex.raw('PRAGMA max_page_count'))[0].max_page_count).toBe(expectedPages)
            expect((await owner.value.store.knex.raw('PRAGMA journal_mode'))[0].journal_mode).toBe('delete')
            await owner.value.store.withAuthenticatedPrivateDestination(async (header, metadata) => {
              expect(header.user).toEqual(semanticStageFixture().user)
              expect(metadata.rows).toBe(13)
            })
          }
        }),
        controls
      )
      expect((await first.root.usage()).imports).toBe(1)
      expect((await second.root.usage()).imports).toBe(1)
    } finally {
      await first.close()
      await second.close()
    }
  }, 30000)

  test('generated retained handles and new registrations reject after actual physical store closure', async () => {
    const target = await fixture()
    try {
      const wrapper = storage(target.value)
      registerBrc38PrivateDestinationLease(wrapper, target.value.store)
      const lease = brc38PrivateDestinationLease(wrapper)!
      lease.assertLive()
      await target.value.store.close()
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 0, max: 31 }), async reads => {
          for (let i = 0; i <= reads; i++) expect(() => lease.assertLive()).toThrow('unavailable')
          expect(() => registerBrc38PrivateDestinationLease(storage(target.value), target.value.store)).toThrow(
            'unavailable'
          )
          await expect(target.value.store.withAuthenticatedPrivateDestination(async () => undefined)).rejects.toThrow(
            'unavailable'
          )
          expect(target.value.store.limits.expiresAt).toBe(target.expiry)
        }),
        controls
      )
      const reopened = await target.root.resume(
        target.value.id,
        target.value.store.limits,
        target.value.store.binding!.binding
      )
      try {
        const successor = storage(reopened)
        expect(brc38PrivateDestinationLease(successor)).toBeUndefined()
        registerBrc38PrivateDestinationLease(successor, reopened.store)
        brc38PrivateDestinationLease(successor)!.assertLive()
        expect(() => lease.assertLive()).toThrow('unavailable')
        expect(reopened.store.limits.expiresAt).toBe(target.expiry)
      } finally {
        await reopened.store.close()
      }
    } finally {
      await target.close()
    }
  }, 30000)

  test('generated access cannot renew the original real wall-clock expiry or enter destination work after it', async () => {
    const target = await fixture(5000)
    try {
      const wrapper = storage(target.value)
      registerBrc38PrivateDestinationLease(wrapper, target.value.store)
      const lease = brc38PrivateDestinationLease(wrapper)!
      const remaining = target.expiry - Date.now()
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining + 1))
      let entered = 0
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 0, max: 31 }), async reads => {
          for (let i = 0; i <= reads; i++) expect(() => lease.assertLive()).toThrow('expired')
          await expect(
            target.value.store.withAuthenticatedPrivateDestination(async () => {
              entered++
            })
          ).rejects.toThrow('expired')
          expect(target.value.store.limits.expiresAt).toBe(target.expiry)
          expect(entered).toBe(0)
        }),
        controls
      )
      expect((await stat(join(target.value.store.directory, 'stage.sqlite'))).mode & 0o777).toBe(0o600)
      expect(await readdir(target.directory)).toContain('brc38-admission.sqlite')
    } finally {
      await target.close()
    }
  }, 30000)
})
