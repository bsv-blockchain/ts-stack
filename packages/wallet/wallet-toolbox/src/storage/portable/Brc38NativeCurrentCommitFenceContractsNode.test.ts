import createKnex from 'knex'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { withBrc38NativeCandidateContractFixture } from './Brc38NativeCandidateContractFixture'
import { verifyBrc38NativeLocalCurrentCommitFence } from './Brc38NativeLocalBaselineSourceNode.case'
import { withComposedFixtureRead } from './Brc38ComposedSemanticFixture'
import { Brc38PublishedProfileNode } from './Brc38PublishedProfileNode'
import { previewReceiptPolicy } from './Brc38ImportPreviewFixture'

// Full original coverage cases measured about 176 seconds, leaving almost no
// margin in the default three-minute fixture. Select one fixed whole-case
// lifetime; the extra 30 seconds is only for physical cleanup.
const nativeFixtureLifetimeMs = 300000
const nativeFixtureCaseTimeoutMs = nativeFixtureLifetimeMs + 30000

// UNRUN. The competing connection is a physical SQLite writer to this fixture's
// own published source file, used only to prove actual SQLITE_BUSY. It grants
// no provider/source authority. Its transaction always rolls back; the genuine
// separate private native destination writer commits the independent receipt.
test(
  'actual current-data fence holds the source WAL writer through a distinct destination commit',
  async () => {
    await withBrc38NativeCandidateContractFixture(
      async fixture => {
        await fixture.prepareCopied()
        const files = await withComposedFixtureRead(
            fixture.source.manager,
            async trx => (await trx.raw('PRAGMA database_list')) as Array<{ name: string; file: string }>
          ),
          main = files.filter(row => row.name === 'main'),
          fixtureRoot = await realpath(fixture.source.directory)
        if (
          main.length !== 1 ||
          !isAbsolute(main[0].file) ||
          (await realpath(main[0].file)) !== main[0].file ||
          !(await lstat(main[0].file)).isFile() ||
          !main[0].file.startsWith(fixtureRoot + '/')
        )
          throw new Error('Competing lock probe must open only the genuine original synthetic source file')
        const competitor = createKnex({
            client: 'better-sqlite3',
            connection: { filename: main[0].file },
            useNullAsDefault: true,
            pool: { min: 1, max: 1 },
            acquireConnectionTimeout: 1000
          }),
          receipt = 'independent destination commit under current source fence',
          unexpectedCommit = new Error('Independent competing source writer unexpectedly acquired the held source')
        try {
          await competitor.raw('PRAGMA busy_timeout=0')
          await verifyBrc38NativeLocalCurrentCommitFence(
            fixture.source.storage,
            fixture.selection,
            previewReceiptPolicy,
            {
              workingAllocation: fixture.options.workingAllocation,
              maximumMetadataBytes: 65536,
              maximumReadBytes: 1024,
              expiresAt: fixture.store.limits.expiresAt
            },
            {
              commitWhileSourceWriterHeld: async () => {
                let busy = false
                try {
                  await competitor.transaction(async trx => {
                    await trx('monitor_events').where({ id: 400 }).update({ event: 'forbidden competing source write' })
                    throw unexpectedCommit
                  })
                } catch (cause) {
                  if (cause !== null && typeof cause === 'object' && 'code' in cause && cause.code === 'SQLITE_BUSY')
                    busy = true
                  else throw cause
                }
                expect(busy).toBe(true)
                await fixture.withWriter(async destination => {
                  expect(await destination('monitor_events').where({ id: 400 }).update({ event: receipt })).toBe(1)
                })
                return receipt
              },
              readDestinationReceipt: async () =>
                await fixture.withRead(async trx => {
                  const rows = (await trx('monitor_events').where({ id: 400 }).select('event').limit(2)) as Array<{
                    event: string
                  }>
                  if (rows.length !== 1) throw new Error('Actual distinct destination receipt missing')
                  return rows[0].event
                }),
              mutateAfterFence: async () =>
                await fixture.source.manager.runAsStorageProvider(async active => {
                  if (active !== fixture.source.storage)
                    throw new Error('Fresh source mutation selected another provider')
                  await Brc38PublishedProfileNode.withNativeImmediateSourceWriter(
                    fixture.source.storage,
                    async writer => {
                      expect(
                        await fixture.source.storage.updateMonitorEvent(
                          400,
                          { event: 'independent live mutation after original source fence' },
                          writer
                        )
                      ).toBe(1)
                    }
                  )
                }),
              check: fixture.check
            }
          )
        } finally {
          await competitor.destroy()
        }
      },
      { lifetimeMs: nativeFixtureLifetimeMs }
    )
  },
  nativeFixtureCaseTimeoutMs
)
