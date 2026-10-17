import { importJournalFixture } from './Brc38ImportJournalFixture'
import { verifyBrc38PublishedWallet } from './Brc38PublishedWalletNode'
import type { FixedProfile } from './Brc38PublishedProfileReceiptNode'

describe('original published wallet journal and identity validation', () => {
  let fixture: Awaited<ReturnType<typeof importJournalFixture>>
  let fixed: FixedProfile
  beforeEach(async () => {
    fixture = await importJournalFixture(0)
    await fixture.k.schema.createTable('users', table => {
      table.integer('userId')
      table.text('identityKey')
      table.text('activeStorage')
    })
    await fixture.k.schema.createTable('settings', table => {
      table.text('chain')
      table.text('storageIdentityKey')
    })
    await fixture.k('users').insert({ userId: 7, identityKey: 'synthetic identity', activeStorage: '' })
    await fixture.k('settings').insert({ chain: 'test', storageIdentityKey: 'synthetic target' })
    await fixture.prepare()
    fixed = {
      protocol: 'brc38-published-profile/v1',
      binding: {
        archiveSha256: 'b'.repeat(64),
        identityKey: 'synthetic identity',
        chain: 'test',
        sourceStorageIdentityKey: 'synthetic source',
        targetStorageIdentityKey: 'synthetic target',
        targetGeneration: 0
      },
      bindingSha256: fixture.admission.scope.bindingSha256,
      limits: JSON.parse(fixture.admission.originalLimitsJson),
      admission: fixture.admission
    }
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await fixture.close()
  })
  it.each([
    ['READY', ''],
    ['ACTIVE', 'synthetic target'],
    ['ACTIVATING', ''],
    ['ACTIVATING', 'synthetic target']
  ] as const)('accepts the original %s primary state', async (state, primary) => {
    await fixture.k('users').update({ activeStorage: primary })
    const before = await fixture.k('brc38_import_journal')
    await expect(verifyBrc38PublishedWallet(fixture.k, fixed, state)).resolves.toBeUndefined()
    expect(await fixture.k('brc38_import_journal')).toEqual(before)
    expect((await fixture.k('users').first()).activeStorage).toBe(primary)
  })
  it('keeps a completed durable wallet readable after its original import expires', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(fixture.admission.expiresAt + 1)
    await expect(verifyBrc38PublishedWallet(fixture.k, fixed, 'READY')).resolves.toBeUndefined()
  })
  it.each([
    'missing user',
    'extra user',
    'wrong user id',
    'wrong identity',
    'missing settings',
    'extra settings',
    'wrong chain',
    'wrong storage identity'
  ] as const)('refuses %s independently of a valid completed journal', async mismatch => {
    if (mismatch === 'missing user') await fixture.k('users').delete()
    if (mismatch === 'extra user')
      await fixture.k('users').insert({ userId: 8, identityKey: 'other identity', activeStorage: '' })
    if (mismatch === 'wrong user id') await fixture.k('users').update({ userId: 8 })
    if (mismatch === 'wrong identity') await fixture.k('users').update({ identityKey: 'other identity' })
    if (mismatch === 'missing settings') await fixture.k('settings').delete()
    if (mismatch === 'extra settings')
      await fixture.k('settings').insert({ chain: 'main', storageIdentityKey: 'other storage' })
    if (mismatch === 'wrong chain') await fixture.k('settings').update({ chain: 'main' })
    if (mismatch === 'wrong storage identity')
      await fixture.k('settings').update({ storageIdentityKey: 'other storage' })
    const before = await fixture.k('brc38_import_journal')
    await expect(verifyBrc38PublishedWallet(fixture.k, fixed, 'READY')).rejects.toThrow(
      'Published profile native identity, chain, completion or primary differs'
    )
    expect(await fixture.k('brc38_import_journal')).toEqual(before)
  })
  it.each([
    ['READY', 'synthetic target'],
    ['ACTIVE', ''],
    ['ACTIVATING', 'other storage']
  ] as const)('refuses an incompatible %s primary', async (state, primary) => {
    await fixture.k('users').update({ activeStorage: primary })
    await expect(verifyBrc38PublishedWallet(fixture.k, fixed, state)).rejects.toThrow(
      'Published profile native identity, chain, completion or primary differs'
    )
    expect((await fixture.k('users').first()).activeStorage).toBe(primary)
  })
  it('refuses incomplete original journal admission', async () => {
    const incomplete = await importJournalFixture(1)
    try {
      await incomplete.prepare()
      await incomplete.k.schema.createTable('users', table => {
        table.integer('userId')
        table.text('identityKey')
        table.text('activeStorage')
      })
      await incomplete.k.schema.createTable('settings', table => {
        table.text('chain')
        table.text('storageIdentityKey')
      })
      await incomplete.k('users').insert({ userId: 7, identityKey: 'synthetic identity', activeStorage: '' })
      await incomplete.k('settings').insert({ chain: 'test', storageIdentityKey: 'synthetic target' })
      await expect(
        verifyBrc38PublishedWallet(incomplete.k, { ...fixed, admission: incomplete.admission }, 'READY')
      ).rejects.toThrow('Published profile native identity, chain, completion or primary differs')
    } finally {
      await incomplete.close()
    }
  })
  it('requires the original durable journal row', async () => {
    await fixture.k('brc38_import_journal').delete()
    await expect(verifyBrc38PublishedWallet(fixture.k, fixed, 'READY')).rejects.toThrow()
  })
  it('propagates a changed original journal schema refusal', async () => {
    await fixture.k.schema.alterTable('brc38_import_journal', table => table.text('unownedColumn'))
    await expect(verifyBrc38PublishedWallet(fixture.k, fixed, 'READY')).rejects.toThrow('schema differs')
  })
  it('keeps the original admission binding on the actual journal read', async () => {
    const wrong = {
      ...fixed,
      admission: { ...fixed.admission, scope: { ...fixed.admission.scope, userId: 8 } }
    }
    await expect(verifyBrc38PublishedWallet(fixture.k, wrong, 'READY')).rejects.toThrow()
  })
})
