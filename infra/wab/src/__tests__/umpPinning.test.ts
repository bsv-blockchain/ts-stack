import { db } from '../db/knex'
import { UserService } from '../services/UserService'

describe('administrative UMP pin persistence', () => {
  beforeEach(async () => {
    await db('phone_change_sessions').del()
    await db('phone_change_history').del()
    await db('auth_methods').del()
    await db('users').del()
  })

  it('sets and clears the additive outpoint field without changing the presentation key', async () => {
    const presentationKey = 'a'.repeat(64)
    const outpoint = `${'b'.repeat(64)}.7`
    const user = await UserService.createUser(presentationKey)

    await UserService.setUMPTokenOutpoint(user.id, outpoint)
    await expect(UserService.getUserById(user.id)).resolves.toMatchObject({
      presentationKey,
      umpTokenOutpoint: outpoint
    })

    await UserService.setUMPTokenOutpoint(user.id, null)
    await expect(UserService.getUserById(user.id)).resolves.toMatchObject({
      presentationKey,
      umpTokenOutpoint: null
    })
  })
})
