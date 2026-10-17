import { createHash } from 'node:crypto'
import { importJournalFixture } from './Brc38ImportJournalFixture'
import { copyBrc38ComposedProfileReceipt } from './Brc38ComposedProfileReceiptNode'
import { fixedProfile, validPrimary, type FixedProfile, type Row } from './Brc38PublishedProfileReceiptNode'
import { verifyBrc38PublishedWallet } from './Brc38PublishedWalletNode'
import { snapshotJournalRevision } from '../snapshot/journal/SnapshotJournalRevision'
import { migrateBrc38NativeCatalog } from './Brc38NativeCatalogNode'
import { readRow } from './Brc38PublishedProfileReceiptNode'
import { writeBrc38NativeBackend } from './Brc38NativeBackendNode'
import { readBrc38ComposedNativeCommit, writeBrc38ComposedNativeCommit } from './Brc38ComposedNativeCommitNode'
import type { Brc38NativeRetirementRecord } from './Brc38NativeRetirementNode'

// UNRUN stock SQLite and receipt DATA cases. Inventories/file coordinates and
// image hashes below are synthetic metadata, never native/profile authority.
describe('explicit composed published receipt and preserved occupied primary', () => {
  let fixture: Awaited<ReturnType<typeof importJournalFixture>>, fixed: FixedProfile
  const row = (value: FixedProfile, state: Row['state'] = 'READY'): Row => {
    const fixedJson = JSON.stringify(value)
    return {
      state,
      fixedJson,
      fixedSha256: createHash('sha256').update(fixedJson).digest('hex'),
      copySha256: 'e'.repeat(64),
      copyBytes: 4096
    }
  }
  beforeEach(async () => {
    fixture = await importJournalFixture(0)
    const limits = JSON.parse(fixture.admission.originalLimitsJson) as number[]
    fixed = {
      protocol: 'brc38-published-profile/v3',
      inventory: {
        rootId: '00000000-0000-4000-8000-000000000002',
        profileId: '00000000-0000-4000-8000-000000000005',
        policySha256: 'a'.repeat(64)
      },
      binding: {
        archiveSha256: 'b'.repeat(64),
        identityKey: 'synthetic identity',
        chain: 'test',
        sourceStorageIdentityKey: 'synthetic source',
        targetStorageIdentityKey: 'synthetic target',
        targetGeneration: 0
      },
      bindingSha256: fixture.admission.scope.bindingSha256,
      limits: {
        maximumRows: limits[0],
        maximumLogicalBytes: limits[1],
        maximumPhysicalBytes: limits[2],
        maximumRowBytes: limits[3],
        maximumRowAllocationBytes: limits[4],
        expiresAt: limits[5]
      },
      admission: fixture.admission,
      physicalIdentity: {
        directory: { device: '1', inode: '2' },
        owner: { device: '1', inode: '3' },
        catalog: { device: '1', inode: '4' },
        wallet: { device: '1', inode: '5' }
      },
      composition: copyBrc38ComposedProfileReceipt({
        protocol: 'brc38-composed-profile/v1',
        decisionId: '00000000-0000-4000-8000-000000000001',
        source: {
          inventory: {
            rootId: '00000000-0000-4000-8000-000000000002',
            profileId: '00000000-0000-4000-8000-000000000003',
            policySha256: 'a'.repeat(64)
          },
          fixedSha256: 'b'.repeat(64),
          copySha256: 'c'.repeat(64),
          copyBytes: 4096,
          epoch: '00000000-0000-4000-8000-000000000004',
          revision: snapshotJournalRevision('9007199254740993'),
          primaryEpoch: snapshotJournalRevision('9007199254740994'),
          userId: 7,
          activeStorage: 'synthetic target'
        },
        image: {
          protocol: 'brc38-composed-database-image/v1',
          sha256: 'd'.repeat(64),
          schemaObjects: 47,
          tables: 47,
          rows: '0',
          cellBytes: '0'
        },
        maximumReadBytes: 1
      })
    }
    await fixture.k.schema.createTable('users', table => {
      table.integer('userId')
      table.text('identityKey')
      table.text('activeStorage')
    })
    await fixture.k.schema.createTable('settings', table => {
      table.text('chain')
      table.text('storageIdentityKey')
    })
    await fixture.k('users').insert({
      userId: 7,
      identityKey: fixed.binding.identityKey,
      activeStorage: fixed.binding.targetStorageIdentityKey
    })
    await fixture
      .k('settings')
      .insert({ chain: fixed.binding.chain, storageIdentityKey: fixed.binding.targetStorageIdentityKey })
    await fixture.prepare()
  })
  afterEach(async () => await fixture.close())
  test('completed lifecycle records only an exact ACTIVE/WAL forward decision, survives loss of the response and refuses altered lineage', async () => {
    const original = row(fixed),
      db = fixture.k,
      build = { platform: 'synthetic data', architecture: 'none', bytes: 1, sha256: 'f'.repeat(64) }
    await db.schema.createTable('profile', table => {
      table.integer('slot').primary()
      table.text('state')
      table.text('fixedJson')
      table.text('fixedSha256')
      table.text('copySha256')
      table.integer('copyBytes')
    })
    await db('profile').insert({ slot: 1, ...original })
    await db.transaction(async trx => {
      await migrateBrc38NativeCatalog(trx, original)
      await writeBrc38NativeBackend(trx, undefined, {
        protocol: 'brc38-native-backend/v1',
        phase: 'DELETE_ACTIVATING',
        fixedSha256: original.fixedSha256,
        copySha256: original.copySha256!,
        copyBytes: original.copyBytes!,
        componentBuild: build
      })
    })
    const source = fixed.composition!.source,
      retirement: Brc38NativeRetirementRecord = {
        protocol: 'brc38-native-retirement/v1',
        decisionId: fixed.composition!.decisionId,
        source: {
          fixedSha256: source.fixedSha256,
          copySha256: source.copySha256,
          copyBytes: source.copyBytes,
          epoch: source.epoch,
          revision: source.revision,
          primaryEpoch: source.primaryEpoch
        },
        target: {
          rootId: fixed.inventory!.rootId,
          profileId: fixed.inventory!.profileId,
          fixedSha256: original.fixedSha256,
          copySha256: original.copySha256!,
          copyBytes: original.copyBytes!
        }
      }
    await expect(
      db.transaction(
        async trx =>
          await writeBrc38ComposedNativeCommit(trx, await readRow(trx), build, fixed.bindingSha256, retirement)
      )
    ).rejects.toThrow('completed lifecycle')
    expect(await db.schema.hasTable('profile_composed_commit')).toBe(false)
    await db('profile_native').update({ state: 'ACTIVE' })
    for (const phase of ['DELETE_ACTIVE', 'WAL_ACTIVATING']) {
      const pending = JSON.stringify({
        protocol: 'brc38-native-backend/v1',
        phase,
        fixedSha256: original.fixedSha256,
        copySha256: original.copySha256,
        copyBytes: original.copyBytes,
        componentBuild: build
      })
      await db('profile_native_backend').update({
        recordJson: pending,
        recordSha256: createHash('sha256').update(pending).digest('hex')
      })
      await expect(
        db.transaction(
          async trx =>
            await writeBrc38ComposedNativeCommit(trx, await readRow(trx), build, fixed.bindingSha256, retirement)
        )
      ).rejects.toThrow('completed lifecycle')
      expect(await db.schema.hasTable('profile_composed_commit')).toBe(false)
    }
    const backendJson = JSON.stringify({
      protocol: 'brc38-native-backend/v1',
      phase: 'WAL',
      fixedSha256: original.fixedSha256,
      copySha256: original.copySha256,
      copyBytes: original.copyBytes,
      componentBuild: build
    })
    await db('profile_native_backend').update({
      recordJson: backendJson,
      recordSha256: createHash('sha256').update(backendJson).digest('hex')
    })
    await expect(
      db.transaction(async trx => {
        await writeBrc38ComposedNativeCommit(trx, await readRow(trx), build, fixed.bindingSha256, retirement)
        throw new Error('stop before completed lifecycle commit')
      })
    ).rejects.toThrow('stop before completed lifecycle commit')
    expect(await db.schema.hasTable('profile_composed_commit')).toBe(false)
    const value = await db.transaction(
      async trx => await writeBrc38ComposedNativeCommit(trx, await readRow(trx), build, fixed.bindingSha256, retirement)
    )
    expect(await readBrc38ComposedNativeCommit(db, await readRow(db), build, fixed.bindingSha256)).toEqual(value)
    const before = await db('profile_composed_commit').select('*')
    expect(
      await db.transaction(
        async trx =>
          await writeBrc38ComposedNativeCommit(trx, await readRow(trx), build, fixed.bindingSha256, retirement)
      )
    ).toEqual(value)
    expect(await db('profile_composed_commit').select('*')).toEqual(before)
    await expect(
      db.transaction(
        async trx =>
          await writeBrc38ComposedNativeCommit(trx, await readRow(trx), build, fixed.bindingSha256, {
            ...retirement,
            target: { ...retirement.target, copyBytes: 8192 }
          })
      )
    ).rejects.toThrow('completed lifecycle')
    const changed = JSON.stringify({ ...value, unknown: true })
    await db('profile_composed_commit').update({
      recordJson: changed,
      recordSha256: createHash('sha256').update(changed).digest('hex')
    })
    await expect(readBrc38ComposedNativeCommit(db, await readRow(db), build, fixed.bindingSha256)).rejects.toThrow(
      'completed lifecycle'
    )
  })
  test('complete canonical source lineage stays independent and accepts only the copied occupied primary', async () => {
    const parsed = fixedProfile(row(fixed), fixed.bindingSha256)
    expect(parsed.composition).toEqual(fixed.composition)
    expect(parsed.composition).not.toBe(fixed.composition)
    expect(Object.isFrozen(parsed.composition!.source.inventory)).toBe(true)
    expect(parsed.composition!.source.revision).toBe('9007199254740993')
    expect(validPrimary('READY', 'synthetic target', 'synthetic target', parsed)).toBe(true)
    expect(validPrimary('READY', '', 'synthetic target', parsed)).toBe(false)
    expect(validPrimary('READY', 'foreign', 'synthetic target', parsed)).toBe(false)
    await expect(verifyBrc38PublishedWallet(fixture.k, parsed, 'READY')).resolves.toBeUndefined()
    await fixture.k('users').update({ activeStorage: '' })
    await expect(verifyBrc38PublishedWallet(fixture.k, parsed, 'READY')).rejects.toThrow('primary differs')
  })
  test('the old restore protocol retains its empty READY primary requirement', async () => {
    const { composition: _composition, ...legacy } = fixed
    const prior: FixedProfile = { ...legacy, protocol: 'brc38-published-profile/v2' }
    expect(validPrimary('READY', 'synthetic target', 'synthetic target', prior)).toBe(false)
    expect(validPrimary('READY', '', 'synthetic target', prior)).toBe(true)
    await expect(verifyBrc38PublishedWallet(fixture.k, prior, 'READY')).rejects.toThrow('primary differs')
    await fixture.k('users').update({ activeStorage: '' })
    await expect(verifyBrc38PublishedWallet(fixture.k, prior, 'READY')).resolves.toBeUndefined()
  })
  test('incomplete, mixed-protocol, changed source/user/primary and unknown persisted metadata refuse', () => {
    expect(() => fixedProfile(row(fixed, 'RECEIVING'), fixed.bindingSha256)).toThrow()
    for (const value of [
      { ...fixed, composition: undefined },
      { ...fixed, physicalIdentity: undefined },
      { ...fixed, inventory: undefined },
      { ...fixed, protocol: 'brc38-published-profile/v2' as const },
      { ...fixed, inventory: fixed.composition!.source.inventory },
      { ...fixed, composition: { ...fixed.composition!, source: { ...fixed.composition!.source, userId: 8 } } },
      {
        ...fixed,
        composition: { ...fixed.composition!, source: { ...fixed.composition!.source, activeStorage: 'foreign' } }
      },
      { ...fixed, unrelated: 'unrecognized composed receipt member' }
    ])
      expect(() => fixedProfile(row(value), fixed.bindingSha256)).toThrow()
  })
})
