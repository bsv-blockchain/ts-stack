import createKnex, { type Knex } from 'knex'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeTestExecutable } from './Brc38NativeTestPath'
import { waitForNativeTestExpiry } from './Brc38NativeTestClock'
import { previewPrivateFixture, previewReceiptPolicy } from './Brc38ImportPreviewFixture'
import { restoreProofFixture, restorePortableProof } from '../../../test/utils/Brc38ImportEntityRestoreFixture'
import { Brc38PrivateNativeRestoreNode } from './Brc38PrivateNativeRestoreNode'
import { Brc38ProfileInventoryNode } from './Brc38ProfileInventoryNode'
import { Brc38NativeRecoveryScratchNode, Brc38NativeRecoveryTemporaryQuota } from './Brc38NativeRecoveryScratchNode'
import { Brc39RecoveryAuthenticationNode } from './Brc39RecoveryAuthenticationNode'
import { Brc38StagingAdmissionNode } from './Brc38StagingAdmissionNode'
import { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { authenticatedStagePassword, encrypted } from './Brc38AuthenticatedPrivateStageFixture'
import { semanticStageFixture } from './Brc38SemanticStageFixture'
import { inspectBrc38PrivateMergePages } from './Brc38PrivateMergePagesNode'
import * as sourceSeal from './Brc38AuthenticatedSourceSealNode'
import { composedNativeFixture, composedFixtureChain } from './Brc38ComposedNativeFixture'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import { equalBrc38PrivateProofOriginalFields } from './Brc38PrivateProofOriginalFieldsNode'
import { readRow } from './Brc38PublishedProfileReceiptNode'

// A real expired original and fresh frozen copy exercise only the read-lifetime
// boundary. The restore fixture deliberately has no merge-page schema: reaching
// and refusing that missing graph is required, never a complete merge verdict.
test('expired page inspection uses only the actual recovery owner and still refuses missing history', async () => {
  const executable = nativeTestExecutable(),
    proof = restoreProofFixture(),
    staged = await previewPrivateFixture(
      undefined,
      data => restorePortableProof(data, proof),
      2097152,
      8388608,
      8388608
    ),
    directory = await mkdtemp(join(tmpdir(), 'brc38-pages-recovery-')),
    root = await Brc38ProfileInventoryNode.create(directory, { maximumProfiles: 1, maximumPhysicalBytes: 11534336 }),
    freshDirectory = await mkdtemp(join(tmpdir(), 'brc38-pages-auth-')),
    admission = await Brc38StagingAdmissionNode.create(freshDirectory, {
      maximumImports: 1,
      maximumPhysicalBytes: 11534336,
      maximumLogicalBytes: 1048576
    }),
    restore = await Brc38PrivateNativeRestoreNode.open(staged.value.reservation.store, {
      receiptPolicy: previewReceiptPolicy,
      maximumStepRows: 16,
      maximumStepBytes: 2097152,
      maximumMappedIds: 1000,
      maximumJournalLogicalBytes: 516096,
      services: proof.services
    })
  let liveSource: Awaited<ReturnType<typeof composedNativeFixture>> | undefined,
    profile: Awaited<ReturnType<typeof root.publish>> | undefined,
    database: Knex | undefined,
    catalog: Knex | undefined,
    session: object | undefined,
    failed = false,
    failure: unknown
  const driver = require('./NativeProfileSqlite.cjs') as {
    NativeProfileSqlite: {
      startForClaim(
        executable: string,
        directory: string,
        fixed: string,
        binding: string
      ): Promise<{ session: object; failure?: unknown }>
    }
    nativeKnex(knex: typeof createKnex, client: unknown, session: object, slot: number): Knex
    drainStartedNativeSession(session: object): Promise<{ failed: boolean; failure?: unknown }>
  }
  try {
    for (let row = 0; row < 14; row++) expect(await restore.step(row)).toMatchObject({ nextRow: row + 1 })
    await restore.close()
    const resumed = await staged.root.resume(
      staged.value.reservation.id,
      staged.selected.limits,
      staged.selected.binding
    )
    staged.held.push(resumed)
    profile = await root.publish(resumed.store, restore.admission)
    catalog = createKnex({
      client: 'better-sqlite3',
      connection: { filename: join(profile.directory, 'profile.sqlite') },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
    const originalRow = await readRow(catalog),
      originalLimits = { ...staged.selected.limits },
      originalBinding = staged.value.reservation.store.binding!
    await catalog.destroy()
    catalog = undefined
    await profile.close()
    // Construct the separate genuine source while the original admission is
    // still alive. Both setups remain inside this unchanged case owner; the
    // comparison below still waits for the real original UTC expiry.
    await waitForNativeTestExpiry(originalLimits.expiresAt - 120000)
    liveSource = await composedNativeFixture(executable)
    await waitForNativeTestExpiry(originalLimits.expiresAt)
    expect(Date.now()).toBeGreaterThanOrEqual(originalLimits.expiresAt)
    const attempt = await driver.NativeProfileSqlite.startForClaim(
      executable,
      profile.directory,
      originalRow.fixedJson,
      originalBinding.digest
    )
    session = attempt.session
    if (attempt.failure !== undefined) throw attempt.failure
    database = driver.nativeKnex(createKnex, require('knex/lib/dialects/sqlite3/index.js'), session, 0)
    const quota = new Brc38NativeRecoveryTemporaryQuota(16777216),
      working = new Brc38WorkingAllocation(8388608),
      expiresAt = Date.now() + 60000,
      data = semanticStageFixture()
    restorePortableProof(data, proof)
    const bytes = await encrypted(data)
    async function* chunks() {
      for (let at = 0; at < bytes.length; at += 137) yield bytes.slice(at, at + 137)
    }
    await Brc38NativeRecoveryScratchNode.withCopiedDatabase(
      database,
      {
        privateParent: directory,
        maximumPhysicalBytes: originalLimits.maximumPhysicalBytes,
        temporaryQuota: quota,
        workingAllocation: working,
        expiresAt
      },
      async scratch => {
        await Brc39RecoveryAuthenticationNode.with(
          chunks(),
          authenticatedStagePassword,
          {
            original: {
              ...staged.selected,
              reservationId: staged.value.reservation.id,
              streamedFields: { maximumBinaryBytes: 262144, maximumChunkBytes: 1024 },
              streamedTextFields: { maximumTextBytes: 262144, maximumChunkBytes: 1024 },
              streamedStructuredFields: {
                fields: { maximumStructuredBytes: 1000000, maximumChunkBytes: 1024 },
                staging: {
                  privateIndexParent: freshDirectory,
                  maximumTemporaryIndexBytes: 1048576,
                  maximumIndexMembers: 10000,
                  maximumStructuredBytes: 1000000,
                  maximumCanonicalBytes: 1000000
                }
              }
            },
            admission,
            temporaryQuota: quota,
            expiresAt,
            executable
          },
          async fresh => {
            await KnexBrc38StagingStore.withRecoveryComparison(
              scratch,
              fresh,
              originalLimits,
              executable,
              async copy => {
                expect(copy.limits).toEqual(originalLimits)
                expect(copy.binding).toEqual(originalBinding)
                expect(copy.operationExpiresAt).toBe(expiresAt)
                expect(() => copy.assertMutableImport()).toThrow('comparison only')
                await copy.withAuthenticatedPrivateStructuredDestination(async () => {
                  await copy.withPrivateNativeDatabase(true, async readDatabase => {
                    await readDatabase.transaction(async read => {
                      const heldWorking = working.used
                      let verified = false
                      const verify = sourceSeal.verifyBrc38AuthenticatedSourceSeal,
                        observer = jest
                          .spyOn(sourceSeal, 'verifyBrc38AuthenticatedSourceSeal')
                          .mockImplementation(async (...args) => {
                            const result = await verify(...args)
                            verified = true
                            return result
                          })
                      try {
                        await expect(
                          inspectBrc38PrivateMergePages(copy, read, restore.admission, { workingAllocation: working })
                        ).rejects.toThrow('Private merge page history differs')
                        expect(verified).toBe(true)
                        const live = liveSource!
                        await Brc38NativeLocalBaselineSource.with(
                          live.storage,
                          {
                            identityKey: live.manager.getActiveUser().identityKey,
                            chain: composedFixtureChain(live.storage),
                            targetStorageIdentityKey: live.manager.getActiveStore(),
                            mode: 'merge'
                          },
                          previewReceiptPolicy,
                          {
                            workingAllocation: working,
                            maximumMetadataBytes: 65536,
                            maximumReadBytes: 1024,
                            expiresAt
                          },
                          async source => {
                            const rows = await Brc38NativeLocalBaselineSource.ownedPage(source, 'proven_txs', null, 2)
                            expect(rows).toHaveLength(1)
                            const original = {
                                origin: 'local' as const,
                                sourceRowId: rows[0],
                                bytes: proof.tx.toBinary().length
                              },
                              selected = {
                                field: 'rawTx' as const,
                                left: original,
                                right: original,
                                maximumReadBytes: 1024,
                                workingAllocation: working
                              }
                            await expect(
                              equalBrc38PrivateProofOriginalFields(copy, source, read, selected)
                            ).resolves.toBe(true)
                            const abort = new AbortController(),
                              stopped = new Error('proof comparison cancelled')
                            abort.abort(stopped)
                            await expect(
                              equalBrc38PrivateProofOriginalFields(copy, source, read, {
                                ...selected,
                                signal: abort.signal
                              })
                            ).rejects.toBe(stopped)
                          }
                        )
                        const abort = new AbortController(),
                          stopped = new Error('page inspection cancelled')
                        abort.abort(stopped)
                        await expect(
                          inspectBrc38PrivateMergePages(copy, read, restore.admission, {
                            workingAllocation: working,
                            signal: abort.signal
                          })
                        ).rejects.toBe(stopped)
                        expect(working.used).toBe(heldWorking)
                      } finally {
                        observer.mockRestore()
                      }
                    })
                  })
                })
              }
            )
          }
        )
      }
    )
    expect(quota.used).toBe(0)
    expect(working.used).toBe(0)
    expect(staged.selected.limits).toEqual(originalLimits)
  } catch (cause) {
    failed = true
    failure = cause
  }
  const errors: unknown[] = []
  for (const close of [
    async () => await database?.destroy(),
    async () => {
      if (session !== undefined) {
        const drained = await driver.drainStartedNativeSession(session)
        if (drained.failed) throw drained.failure ?? new Error('Recovery fixture native cleanup failed')
      }
    },
    async () => await catalog?.destroy(),
    async () => await liveSource?.close(),
    async () => await profile?.close(),
    async () => await restore.close(),
    async () => await admission.close(),
    async () => await root.close(),
    async () => await staged.close()
  ]) {
    try {
      await close()
    } catch (cause) {
      errors.push(cause)
    }
  }
  if (errors.length !== 0)
    throw new AggregateError(failed ? [failure, ...errors] : errors, 'Recovery fixture retains physical cleanup')
  await rm(freshDirectory, { recursive: true, force: true })
  await rm(directory, { recursive: true, force: true })
  if (failed) throw failure
}, 270000)
