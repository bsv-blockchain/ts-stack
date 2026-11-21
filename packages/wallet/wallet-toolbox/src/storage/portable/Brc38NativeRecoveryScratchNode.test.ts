import { nativeTestExecutable } from './Brc38NativeTestPath'
import createKnex, { type Knex } from 'knex'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Brc38NativeRecoveryScratchNode, Brc38NativeRecoveryTemporaryQuota } from './Brc38NativeRecoveryScratchNode'
import { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { previewPrivateFixture } from './Brc38ImportPreviewFixture'

// Authored UNRUN: genuine stock/private owner refusals and resource ownership.
// These cases do not qualify pending-target semantic reconstruction or activation.
describe('new native recovery scratch lifetime', () => {
  let parent: string, stock: Knex | undefined, fixture: Awaited<ReturnType<typeof previewPrivateFixture>> | undefined
  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'brc38-recovery-scratch-'))
  })
  afterEach(async () => {
    await stock?.destroy()
    stock = undefined
    await fixture?.close()
    fixture = undefined
    await rm(parent, { recursive: true, force: true })
  })
  const policy = (privateParent: string) => ({
    privateParent,
    maximumPhysicalBytes: 1048576,
    temporaryQuota: new Brc38NativeRecoveryTemporaryQuota(2097152),
    workingAllocation: new Brc38WorkingAllocation(262144),
    expiresAt: Date.now() + 60000
  })
  test('capacity stays charged until its actual reservation closes, including independent concurrent reservations', () => {
    const quota = new Brc38NativeRecoveryTemporaryQuota(2097152),
      first = quota.claim(1048576),
      second = quota.claim(1048576)
    expect(quota.used).toBe(2097152)
    expect(() => quota.claim(1)).toThrow('already reserved')
    expect(() => Brc38NativeRecoveryTemporaryQuota.prototype.claim.call({ ...quota }, 1)).toThrow()
    first.close()
    first.close()
    expect(quota.used).toBe(1048576)
    const third = quota.claim(1048576)
    second.close()
    third.close()
    expect(quota.used).toBe(0)
  })
  test('a genuine stock transaction and its copied shape cannot create native recovery authority', async () => {
    stock = createKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
    const resources = policy(parent)
    await stock.transaction(async read => {
      await expect(
        Brc38NativeRecoveryScratchNode.withCopiedSnapshot(read, resources, async () => {
          throw new Error('Stock recovery consumer must not be entered')
        })
      ).rejects.toThrow('actual native READ')
      await expect(
        Brc38NativeRecoveryScratchNode.withCopiedSnapshot(
          Object.freeze({ ...read }) as Knex.Transaction,
          resources,
          async () => undefined
        )
      ).rejects.toThrow('actual native READ')
    })
    expect(resources.temporaryQuota.used).toBe(0)
    expect(resources.workingAllocation.used).toBe(0)
    expect(await readdir(parent)).toEqual([])
  })
  test('a genuine private-stage native Root3 cannot impersonate a permanent published target', async () => {
    fixture = await previewPrivateFixture()
    const { root, selected, value } = fixture
    await value.reservation.store.close()
    const reservation = await root.resumeNative(
      value.reservation.id,
      selected.limits,
      selected.binding,
      nativeTestExecutable()
    )
    fixture.held.push(reservation)
    const store = reservation.store,
      resources = policy(parent)
    await store.withAuthenticatedPrivateStructuredDestination(
      async () =>
        await store.withPrivateNativeDatabase(
          true,
          async database =>
            await database.transaction(async read => {
              await expect(
                Brc38NativeRecoveryScratchNode.withCopiedSnapshot(read, resources, async () => {
                  throw new Error('Private source recovery consumer must not be entered')
                })
              ).rejects.toThrow('published Root3')
            })
        )
    )
    expect(resources.temporaryQuota.used).toBe(0)
    expect(resources.workingAllocation.used).toBe(0)
    expect(await readdir(parent)).toEqual([])
  })
})
