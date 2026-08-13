import { db } from '../db/knex'
import { PhoneChangeService } from '../services/PhoneChangeService'
import { UserService } from '../services/UserService'

describe('PhoneChangeService', () => {
  beforeEach(async () => {
    await db('phone_change_sessions').del()
    await db('phone_change_history').del()
    await db('auth_methods').del()
    await db('users').del()
  })

  it('allows the same phone to roll the presentation key and records support history', async () => {
    const oldKey = '1'.repeat(64)
    const newKey = '2'.repeat(64)
    const user = await UserService.createUser(oldKey)
    const method = await UserService.linkAuthMethod(user.id, 'TwilioPhone', '+15555550100')
    await UserService.setUMPTokenOutpoint(user.id, `${'f'.repeat(64)}.0`)
    const token = await PhoneChangeService.createAuthorization(
      user.id,
      'TwilioPhone',
      '+15555550100'
    )

    const changeId = await PhoneChangeService.commit(token, oldKey, newKey)

    await expect(UserService.getUserById(user.id)).resolves.toMatchObject({
      presentationKey: newKey,
      umpTokenOutpoint: null
    })
    await expect(db('auth_methods').where({ id: method.id }).first()).resolves.toMatchObject({
      userId: user.id
    })
    await expect(db('phone_change_history').where({ id: changeId }).first()).resolves.toMatchObject(
      {
        targetUserId: user.id,
        previousPhoneOwnerUserId: user.id,
        previousPresentationKey: oldKey,
        newPresentationKey: newKey
      }
    )
  })

  it('transfers a verified phone and lets support restore the prior ownership record', async () => {
    const oldOwner = await UserService.createUser('3'.repeat(64))
    const target = await UserService.createUser('4'.repeat(64))
    const targetOldPhone = await UserService.linkAuthMethod(
      target.id,
      'TwilioPhone',
      '+15555550101'
    )
    const claimedPhone = await UserService.linkAuthMethod(
      oldOwner.id,
      'TwilioPhone',
      '+15555550102'
    )
    const token = await PhoneChangeService.createAuthorization(
      target.id,
      'TwilioPhone',
      '+15555550102'
    )

    const changeId = await PhoneChangeService.commit(token, target.presentationKey, '5'.repeat(64))
    await expect(db('auth_methods').where({ id: claimedPhone.id }).first()).resolves.toMatchObject({
      userId: target.id
    })
    await expect(
      db('auth_methods').where({ id: targetOldPhone.id }).first()
    ).resolves.toMatchObject({
      userId: null
    })

    await PhoneChangeService.restore(changeId)
    await expect(db('auth_methods').where({ id: claimedPhone.id }).first()).resolves.toMatchObject({
      userId: oldOwner.id
    })
    await expect(
      db('auth_methods').where({ id: targetOldPhone.id }).first()
    ).resolves.toMatchObject({
      userId: target.id
    })
  })
})
