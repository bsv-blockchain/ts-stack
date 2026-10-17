import {
  withBrc38NativeCandidateContractFixture,
  type Brc38NativeCandidateContractFixture
} from './Brc38NativeCandidateContractFixture'
import { verifyBrc38PrivateUserInventory, type IndependentUserInventoryRow } from './Brc38PrivateUserInventoryNode.case'
import { Brc38PublishedProfileNode } from './Brc38PublishedProfileNode'
import { reserveBrc38NativeIncomingIds } from './Brc38NativeIncomingIdReservationNode'
import { runBrc38PrivateNativeMerge } from './Brc38PrivateNativeMergeRunnerNode'
import { previewReceiptPolicy } from './Brc38ImportPreviewFixture'

// Original three-date workflows expired at 180 seconds during full merge.
// Admit setup, initial full merge and source-revision full refold locally.
// Preserve every variant and the fixture default for other callers.
const nativeFixtureLifetimeMs = 180000 + 180000 + 180000
const nativeFixtureCaseTimeoutMs = nativeFixtureLifetimeMs + 30000

const otherIdentity = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5',
  extraIdentity = '02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9'

async function users(fixture: Brc38NativeCandidateContractFixture): Promise<readonly IndependentUserInventoryRow[]> {
  return await fixture.withRead(async trx => {
    const sizes = await trx('users')
      .select(
        trx.raw(
          'coalesce(length(CAST(identityKey AS BLOB)),0)+coalesce(length(CAST(activeStorage AS BLOB)),0) AS bytes'
        )
      )
      .limit(4)
    if (
      sizes.length > 3 ||
      sizes.some((row: { bytes: number }) => !Number.isSafeInteger(row.bytes) || row.bytes > 4096)
    )
      throw new Error('Independent bounded user fixture exceeds its original metadata admission')
    const rows = (await trx('users')
      .select('created_at', 'updated_at', 'userId', 'identityKey', 'activeStorage')
      .orderBy('userId')
      .options({ safeIntegers: true })
      .limit(4)) as Array<Record<string, unknown>>
    return rows.map(metadata => {
      if (
        Object.keys(metadata).length !== 5 ||
        Object.values(metadata).some(
          value =>
            value !== null &&
            typeof value !== 'string' &&
            typeof value !== 'bigint' &&
            !(typeof value === 'number' && Number.isFinite(value))
        )
      )
        throw new Error('Independent user fixture has an unexpected typed cell')
      const physicalRowId = Number(metadata.userId)
      if (!Number.isSafeInteger(physicalRowId)) throw new Error('Independent user physical key differs')
      return { physicalRowId, metadata: metadata as Record<string, string | number | bigint | null> }
    })
  })
}
async function finish(fixture: Brc38NativeCandidateContractFixture): Promise<void> {
  const iterator = runBrc38PrivateNativeMerge(
    fixture.store,
    fixture.source.storage,
    fixture.selection,
    fixture.options,
    4096
  )
  try {
    for (let step = 0; step < 4097; step++) {
      fixture.check()
      if ((await iterator.next()).done) return
    }
    throw new Error('Actual user fixture exceeded its original complete merge operation guard')
  } finally {
    await iterator.return(undefined as never)
  }
}

test.each(['2026-10-02', '2026-10-03', '2026-10-04'])(
  'actual user inventory preserves the second profile, enforces current NULL constraints and applies header date %s',
  async day => {
    await withBrc38NativeCandidateContractFixture(
      async fixture => {
        const selectedId = fixture.source.manager.getActiveUser().userId,
          incomingDate = day + 'T00:00:00.000Z',
          expected = fixture.initial.users.map(row => {
            const metadata = { ...row.metadata },
              original = metadata.updated_at
            if (typeof original !== 'string') throw new Error('Independent current SQLite user date encoding differs')
            if (Number(metadata.userId) === selectedId && Date.parse(incomingDate) > Date.parse(original))
              metadata.updated_at = incomingDate
            return { physicalRowId: row.rowId, metadata: metadata as Record<string, string | number | bigint | null> }
          })
        expect(expected).toHaveLength(2)
        expect(expected.find(row => row.physicalRowId === 2)?.metadata.activeStorage).toBe('')
        await reserveBrc38NativeIncomingIds(
          fixture.source.storage,
          fixture.selection,
          previewReceiptPolicy,
          fixture.store,
          { workingAllocation: fixture.options.workingAllocation }
        )
        await finish(fixture)
        await verifyBrc38PrivateUserInventory(
          {
            get store() {
              return fixture.store
            },
            options: fixture.options,
            withSource: fixture.withSource,
            readUsers: async () => await users(fixture),
            assertOtherUserNullRefused: async () => {
              await expect(
                fixture.withWriter(async trx => {
                  await trx('users').where({ userId: 2 }).update({ activeStorage: null })
                })
              ).rejects.toThrow(/NOT NULL|constraint/i)
            },
            withVariant: async (variant, work) => {
              if (variant === 'source-revision') {
                const change = async (activeStorage: string): Promise<void> =>
                  await fixture.source.manager.runAsStorageProvider(async active => {
                    expect(active).toBe(fixture.source.storage)
                    await Brc38PublishedProfileNode.withNativeImmediateSourceWriter(
                      fixture.source.storage,
                      async writer => {
                        expect(
                          await fixture.source.storage.updateUser(
                            2,
                            { activeStorage, updated_at: new Date('2026-10-03T00:00:00.000Z') },
                            writer
                          )
                        ).toBe(1)
                      }
                    )
                  })
                await change('independent source change')
                try {
                  return await work()
                } finally {
                  await change('')
                  // Real clock revisions remain advanced. A fresh complete refold
                  // catches up; no clock, receipt, range or resource is reset.
                  await finish(fixture)
                }
              }
              const before = await users(fixture),
                target = before.find(row => row.physicalRowId === selectedId),
                other = before.find(row => row.physicalRowId === 2)
              if (target === undefined || other === undefined) throw new Error('Independent user fault graph differs')
              await fixture.withWriter(async trx => {
                const update: Record<string, string | number> = {},
                  key =
                    variant === 'wrong-user-id' || variant === 'other-user-changed' || variant === 'missing-user'
                      ? 2
                      : selectedId
                if (variant === 'missing-user') expect(await trx('users').where({ userId: key }).delete()).toBe(1)
                else if (variant === 'extra-user')
                  await trx('users').insert({ ...other.metadata, userId: 3, identityKey: extraIdentity })
                else {
                  if (variant === 'created-date') update.created_at = '2026-10-02T00:00:00.000Z'
                  else if (variant === 'older-header') update.updated_at = '2026-10-01T00:00:00.000Z'
                  else if (variant === 'wrong-updated-date') update.updated_at = '2026-10-08T00:00:00.000Z'
                  else if (variant === 'wrong-identity') update.identityKey = extraIdentity
                  else if (variant === 'wrong-active-storage') update.activeStorage = 'independent wrong primary'
                  else if (variant === 'wrong-user-id') update.userId = -2
                  else if (variant === 'other-user-changed') update.activeStorage = 'independent other-profile mutation'
                  else throw new Error('Independent user fixture omitted its exact fault variant')
                  expect(await trx('users').where({ userId: key }).update(update)).toBe(1)
                }
              })
              try {
                return await work()
              } finally {
                await fixture.withWriter(async trx => {
                  if (variant === 'wrong-user-id')
                    expect(await trx('users').where({ userId: -2 }).update({ userId: 2 })).toBe(1)
                  if (variant === 'extra-user') expect(await trx('users').where({ userId: 3 }).delete()).toBe(1)
                  if (variant === 'missing-user') await trx('users').insert(other.metadata)
                  for (const row of before)
                    expect(await trx('users').where({ userId: row.physicalRowId }).update(row.metadata)).toBe(1)
                })
              }
            },
            check: fixture.check
          },
          expected,
          day === '2026-10-04'
        )
      },
      {
        lifetimeMs: nativeFixtureLifetimeMs,
        customize: (source, incoming) => {
          source.user.created_at = incoming.user.created_at = '2026-10-01T00:00:00.000Z'
          incoming.user.updated_at = day + 'T00:00:00.000Z'
        },
        prepareSource: async source =>
          await source.manager.runAsStorageProvider(async active => {
            expect(active).toBe(source.storage)
            await Brc38PublishedProfileNode.withNativeImmediateSourceWriter(source.storage, async writer => {
              expect(
                await source.storage.insertUser(
                  {
                    userId: 2,
                    identityKey: otherIdentity,
                    activeStorage: '',
                    created_at: new Date('2026-10-03T00:00:00.000Z'),
                    updated_at: new Date('2026-10-03T00:00:00.000Z')
                  },
                  writer
                )
              ).toBe(2)
            })
          })
      }
    )
  },
  nativeFixtureCaseTimeoutMs
)
