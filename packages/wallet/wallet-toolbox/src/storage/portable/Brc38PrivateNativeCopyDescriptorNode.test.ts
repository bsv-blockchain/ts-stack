import { nativeTestExecutable } from './Brc38NativeTestPath'
import { open, rename, copyFile, unlink, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { previewPrivateFixture } from './Brc38ImportPreviewFixture'
import { Brc38PrivateNativeOwnershipNode } from './Brc38PrivateNativeOwnershipNode'
import { privateNativeDatabaseIdentity } from './Brc38PrivateNativeOwnershipNode'
import type { Knex } from 'knex'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'

// UNRUN actual original native claim and opened descriptor checks. This is
// physical custody evidence only, not semantic comparison or publication.
describe('private copy retains its actual claimed source file identity', () => {
  test('SQL can reopen only on its physically drained original comparison kernel and keeps semantic mutation frozen', async () => {
    const fixture = await previewPrivateFixture(),
      original = fixture.value.reservation.store
    let claim: Awaited<ReturnType<typeof Brc38PrivateNativeOwnershipNode.claimExisting>> | undefined,
      reopened: Knex | undefined,
      failed = false,
      failure: unknown
    const cleanup = async (): Promise<void> => {
      if (failure instanceof Brc38StagingCleanupError) await failure.retryCleanup()
      if (reopened !== undefined) {
        await reopened.destroy()
        reopened = undefined
      }
      if (claim !== undefined) {
        await claim.database.destroy()
        await claim.owner.release()
        claim = undefined
      }
      await fixture.close()
    }
    try {
      await expect(original.reopenComparedNativeSql()).rejects.toThrow('physically drained private kernel')
      await original.close()
      claim = await Brc38PrivateNativeOwnershipNode.claimExisting(
        original.directory,
        original.limits,
        original.binding!,
        nativeTestExecutable()
      )
      const database = claim.database,
        owner = claim.owner
      await database.raw('CREATE TABLE comparison_reopen_probe(id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
      await database('comparison_reopen_probe').insert({ id: 1, value: 'original' })
      const token = privateNativeDatabaseIdentity(database)!.token
      await expect(owner.reopenComparedDatabase(database)).rejects.toThrow('physically drained original root')
      await owner.beginComparison(database)
      await database.destroy()
      await expect(owner.reopenComparedDatabase(Object.freeze({ ...database }) as Knex)).rejects.toThrow(
        'physically drained original root'
      )
      const borrowed = owner.createReadDatabase()
      try {
        await borrowed.raw('SELECT 1')
        await expect(owner.reopenComparedDatabase(database)).rejects.toThrow('physically drained original root')
      } finally {
        await borrowed.destroy()
      }
      reopened = await owner.reopenComparedDatabase(database)
      expect(privateNativeDatabaseIdentity(reopened)?.token).toBe(token)
      await owner.requireComparison(reopened)
      expect(await reopened('comparison_reopen_probe').select('*')).toEqual([{ id: 1, value: 'original' }])
      await expect(reopened('comparison_reopen_probe').update({ value: 'changed' })).rejects.toMatchObject({
        code: 'SQLITE_AUTH'
      })
      await expect(reopened.raw('DROP TABLE comparison_reopen_probe')).rejects.toMatchObject({ code: 'SQLITE_AUTH' })
      expect(owner.expiresAt).toBe(original.limits.expiresAt)
      await reopened.destroy()
      reopened = undefined
      // A second SQL-only reopen still belongs to the same frozen process.
      // The original facade cannot be used to bypass an already live Root0.
      reopened = await owner.reopenComparedDatabase(database)
      await expect(owner.reopenComparedDatabase(database)).rejects.toThrow('physically drained original root')
      await owner.requireComparison(reopened)
    } catch (cause) {
      failed = true
      failure = cause
    }
    try {
      await cleanup()
    } catch (cause) {
      throw new Brc38StagingCleanupError(
        failed ? [failure, cause] : [cause],
        'Original comparison SQL reopen fixture retains physical cleanup',
        cleanup
      )
    }
    if (failed) throw failure
  })
  test('genuine original owner refuses a different descriptor and a same-byte pathname substitution', async () => {
    const fixture = await previewPrivateFixture(),
      original = fixture.value.reservation.store
    const filename = join(original.directory, 'stage.sqlite'),
      backup = filename + '.original'
    let claim: Awaited<ReturnType<typeof Brc38PrivateNativeOwnershipNode.claimExisting>> | undefined,
      source: FileHandle | undefined,
      moved = false,
      failed = false,
      failure: unknown
    const cleanup = async (): Promise<void> => {
      // A failed factory may itself retain a real native owner. Drain that
      // concrete cleanup before the fixture is allowed to remove its directory.
      if (failure instanceof Brc38StagingCleanupError) await failure.retryCleanup()
      if (moved) {
        await unlink(filename).catch(cause => {
          if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
        })
        await rename(backup, filename)
        moved = false
      }
      await source?.close()
      source = undefined
      if (claim !== undefined) {
        await claim.database.destroy()
        await claim.owner.release()
        claim = undefined
      }
      await fixture.close()
    }
    try {
      await original.close()
      claim = await Brc38PrivateNativeOwnershipNode.claimExisting(
        original.directory,
        original.limits,
        original.binding!,
        nativeTestExecutable()
      )
      const { owner } = claim
      source = await open(filename, 'r')
      await owner.assertCopySource(source)
      const other = await open(join(original.directory, 'brc38-owner.sqlite'), 'r')
      try {
        await expect(owner.assertCopySource(other)).rejects.toThrow('opened descriptor identity differs')
      } finally {
        await other.close()
      }
      await rename(filename, backup)
      moved = true
      await copyFile(backup, filename)
      // The opened original descriptor still matches. The fresh pathname check
      // must independently refuse a replacement bearing identical SQLite bytes.
      await expect(owner.assertCopySource(source)).rejects.toThrow('source or owner identity differs')
      await unlink(filename)
      await rename(backup, filename)
      moved = false
      await owner.assertCopySource(source)
    } catch (cause) {
      failed = true
      failure = cause
    }
    try {
      await cleanup()
    } catch (cause) {
      throw new Brc38StagingCleanupError(
        failed ? [failure, cause] : [cause],
        'Private native descriptor fixture retains actual physical cleanup',
        cleanup
      )
    }
    if (failed) throw failure
  })
})
