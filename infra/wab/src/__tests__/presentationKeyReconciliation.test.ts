import knex from 'knex'
import { db } from '../db/knex'
import { up as expandPresentationKeyVaultSchema } from '../db/migrations/2026-08-31-001-encrypt-presentation-keys'
import { reconcilePresentationKeyVault } from '../security/presentationKeyReconciliation'
import { storedPendingPresentationKeyColumns, UserService } from '../services/UserService'

describe('presentation key vault rollout', () => {
  const key = 'a1'.repeat(32)
  const pendingKey = 'b2'.repeat(32)

  beforeEach(async () => {
    process.env.WAB_PRESENTATION_KEY_ENCRYPTION_KEY = '1'.repeat(64)
    process.env.WAB_PRESENTATION_KEY_ENCRYPTION_MODE = 'legacy'
    await db('phone_change_sessions').del()
    await db('phone_change_history').del()
    await db('auth_methods').del()
    await db('users').del()
  })

  afterEach(() => {
    process.env.WAB_PRESENTATION_KEY_ENCRYPTION_KEY = '1'.repeat(64)
    process.env.WAB_PRESENTATION_KEY_ENCRYPTION_MODE = 'encrypted'
  })

  it('expands an existing database without rewriting legacy key columns', async () => {
    const legacyDb = knex({
      client: 'sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })
    try {
      await legacyDb.schema.createTable('users', table => {
        table.increments('id').primary()
        table.string('presentationKey').notNullable().unique()
        table.string('pendingPresentationKey', 64).nullable()
      })
      await legacyDb.schema.createTable('phone_change_history', table => {
        table.increments('id').primary()
        table.string('previousPresentationKey', 64).notNullable()
        table.string('newPresentationKey', 64).notNullable()
      })
      await legacyDb('users').insert({ presentationKey: key, pendingPresentationKey: pendingKey })
      await legacyDb('phone_change_history').insert({
        previousPresentationKey: key,
        newPresentationKey: pendingKey
      })

      await expandPresentationKeyVaultSchema(legacyDb)

      await expect(legacyDb('users').first()).resolves.toMatchObject({
        presentationKey: key,
        pendingPresentationKey: pendingKey,
        presentationKeyLookup: null,
        presentationKeyCiphertext: null
      })
      await expect(legacyDb('phone_change_history').first()).resolves.toMatchObject({
        previousPresentationKey: key,
        newPresentationKey: pendingKey,
        previousPresentationKeyCiphertext: null,
        newPresentationKeyCiphertext: null
      })
    } finally {
      await legacyDb.destroy()
    }
  })

  it('keeps legacy rows and API behavior compatible through dual-write and encrypted modes', async () => {
    const [userId] = await db('users').insert({
      presentationKey: key,
      pendingPresentationKey: pendingKey
    })
    const [historyId] = await db('phone_change_history').insert({
      targetUserId: userId,
      phoneAuthMethodId: null,
      previousPhoneOwnerUserId: null,
      replacedAuthMethodId: null,
      methodType: 'TwilioPhone',
      config: '+15555550100',
      previousPresentationKey: key,
      newPresentationKey: pendingKey,
      createdAtEpochMs: Date.now(),
      finalizedAtEpochMs: null,
      restoredAtEpochMs: null
    })

    await expect(UserService.getUserByPresentationKey(key)).resolves.toMatchObject({
      id: userId,
      presentationKey: key,
      pendingPresentationKey: pendingKey
    })

    process.env.WAB_PRESENTATION_KEY_ENCRYPTION_MODE = 'dual-write'
    await expect(reconcilePresentationKeyVault(db)).resolves.toMatchObject({
      mode: 'dual-write',
      usersUpdated: 1,
      historyRowsUpdated: 1
    })
    const dualUser = await db('users').where({ id: userId }).first()
    expect(dualUser).toMatchObject({ presentationKey: key, pendingPresentationKey: pendingKey })
    expect(dualUser.presentationKeyLookup).toMatch(/^[0-9a-f]{64}$/)
    expect(dualUser.presentationKeyCiphertext).toMatch(/^v1\./)
    await expect(reconcilePresentationKeyVault(db)).resolves.toMatchObject({
      usersUpdated: 0,
      historyRowsUpdated: 0
    })

    process.env.WAB_PRESENTATION_KEY_ENCRYPTION_MODE = 'encrypted'
    await reconcilePresentationKeyVault(db)
    const encryptedUser = await db('users').where({ id: userId }).first()
    const encryptedHistory = await db('phone_change_history').where({ id: historyId }).first()
    expect(encryptedUser.presentationKey).toMatch(/^redacted_/)
    expect(encryptedUser.pendingPresentationKey).toBeNull()
    expect(encryptedHistory.previousPresentationKey).toMatch(/^redacted_/)
    expect(encryptedHistory.newPresentationKey).toMatch(/^redacted_/)
    expect(JSON.stringify({ encryptedUser, encryptedHistory })).not.toContain(key)
    expect(JSON.stringify({ encryptedUser, encryptedHistory })).not.toContain(pendingKey)
    await expect(UserService.getUserByPresentationKey(key)).resolves.toMatchObject({
      id: userId,
      presentationKey: key,
      pendingPresentationKey: pendingKey
    })
  })

  it('finds plaintext rows written by a legacy replica during dual-write rollout', async () => {
    process.env.WAB_PRESENTATION_KEY_ENCRYPTION_MODE = 'dual-write'
    const [id] = await db('users').insert({ presentationKey: key })

    await expect(UserService.getUserByPresentationKey(key)).resolves.toMatchObject({ id })
    await reconcilePresentationKeyVault(db)
    await expect(db('users').where({ id }).first()).resolves.toMatchObject({
      presentationKey: key,
      presentationKeyLookup: expect.stringMatching(/^[0-9a-f]{64}$/),
      presentationKeyCiphertext: expect.stringMatching(/^v1\./)
    })
  })

  it('treats legacy plaintext updates as authoritative during dual-write', async () => {
    process.env.WAB_PRESENTATION_KEY_ENCRYPTION_MODE = 'dual-write'
    const user = await UserService.createUser(key)
    await db('users').where({ id: user.id }).update(storedPendingPresentationKeyColumns(pendingKey))

    const rotatedKey = 'c3'.repeat(32)
    // Simulate an old replica, which knows only the legacy columns.
    await db('users').where({ id: user.id }).update({
      presentationKey: rotatedKey,
      pendingPresentationKey: null
    })

    await expect(UserService.getUserByPresentationKey(rotatedKey)).resolves.toMatchObject({
      presentationKey: rotatedKey,
      pendingPresentationKey: null
    })
    await reconcilePresentationKeyVault(db)
    const reconciled = await db('users').where({ id: user.id }).first()
    expect(reconciled).toMatchObject({
      presentationKey: rotatedKey,
      pendingPresentationKey: null,
      pendingPresentationKeyLookup: null,
      pendingPresentationKeyCiphertext: null
    })
    await expect(UserService.getUserByPresentationKey(rotatedKey)).resolves.toMatchObject({
      presentationKey: rotatedKey,
      pendingPresentationKey: null
    })
  })
})
