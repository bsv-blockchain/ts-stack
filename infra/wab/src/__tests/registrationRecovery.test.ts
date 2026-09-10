import { db } from '../db/knex'
import { RegistrationController } from '../controllers/RegistrationController'
import { AdminController } from '../controllers/AdminController'
import {
  RegistrationRecoveryError,
  RegistrationRecoveryService,
  registrationRecoveryService
} from '../services/RegistrationRecoveryService'
import { UserService } from '../services/UserService'

function mockResponse(): any {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}

describe('pending WAB registration recovery', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  beforeEach(async () => {
    await db('phone_change_sessions').del()
    await db('phone_change_history').del()
    await db('auth_methods').del()
    await db('users').del()
  })

  it('creates and links a pending registration atomically, then reuses its key', async () => {
    const presentationKey = 'a'.repeat(64)
    const first = await UserService.findOrCreatePendingRegistration(
      presentationKey,
      'TwilioPhone',
      '+14155550120'
    )
    const retry = await UserService.findOrCreatePendingRegistration(
      'b'.repeat(64),
      'TwilioPhone',
      '+14155550120'
    )

    expect(first).toMatchObject({
      created: true,
      user: { presentationKey, registrationStatus: 'pending' }
    })
    expect(retry).toMatchObject({
      created: false,
      user: { presentationKey, registrationStatus: 'pending' }
    })
    await expect(db('users')).resolves.toHaveLength(1)
    await expect(db('auth_methods')).resolves.toHaveLength(1)
  })

  it('finalizes a registration idempotently without changing its key or auth identity', async () => {
    const presentationKey = 'c'.repeat(64)
    const { user } = await UserService.findOrCreatePendingRegistration(
      presentationKey,
      'TwilioPhone',
      '+14155550121'
    )
    const req = { body: { presentationKey } } as any

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = mockResponse()
      await RegistrationController.finalize(req, res)
      expect(res.json).toHaveBeenCalledWith({ success: true, registrationStatus: 'active' })
    }

    await expect(UserService.getUserById(user.id)).resolves.toMatchObject({
      presentationKey,
      registrationStatus: 'active'
    })
    await expect(
      UserService.findUserByConfig('TwilioPhone', '+14155550121')
    ).resolves.toMatchObject({ id: user.id })
  })

  it('keeps ordinary and migrated-style users active unless support explicitly reopens one', async () => {
    const presentationKey = 'd'.repeat(64)
    const user = await UserService.createUser(presentationKey)
    await UserService.linkAuthMethod(user.id, 'TwilioPhone', '+14155550122')
    expect(user.registrationStatus).toBe('active')

    jest
      .spyOn(registrationRecoveryService, 'reopenIfUMPAbsent')
      .mockImplementation(async target => UserService.reopenRegistration(target.id))

    const res = mockResponse()
    await AdminController.reopenRegistration(
      {
        body: {
          methodType: 'TwilioPhone',
          payload: { phoneNumber: '+14155550122' }
        }
      } as any,
      res
    )

    expect(res.json).toHaveBeenCalledWith({ success: true, registrationStatus: 'pending' })
    await expect(UserService.getUserById(user.id)).resolves.toMatchObject({
      registrationStatus: 'pending'
    })
  })

  it('rejects malformed finalization credentials without querying a user', async () => {
    const lookup = jest.spyOn(UserService, 'finalizeRegistration')
    const res = mockResponse()
    await RegistrationController.finalize({ body: { presentationKey: 'not-a-key' } } as any, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('reopens only after the server verifies that UMP is cleanly empty', async () => {
    const user = await UserService.createUser('e'.repeat(64))
    const lookup = jest.fn().mockResolvedValue(undefined)
    const service = new RegistrationRecoveryService({ findByPresentationKeyHash: lookup })

    await service.reopenIfUMPAbsent(user)

    expect(lookup).toHaveBeenCalledTimes(1)
    expect(lookup.mock.calls[0]?.[0]).toHaveLength(32)
    await expect(UserService.getUserById(user.id)).resolves.toMatchObject({
      registrationStatus: 'pending'
    })
  })

  it('keeps the registration active when UMP has a token or lookup is indeterminate', async () => {
    const user = await UserService.createUser('f'.repeat(64))
    const found = new RegistrationRecoveryService({
      findByPresentationKeyHash: jest
        .fn()
        .mockResolvedValue({ currentOutpoint: `${'1'.repeat(64)}.0` })
    })
    const unavailable = new RegistrationRecoveryService({
      findByPresentationKeyHash: jest.fn().mockRejectedValue(new Error('lookup unavailable'))
    })

    await expect(found.reopenIfUMPAbsent(user)).rejects.toEqual(
      expect.objectContaining<Partial<RegistrationRecoveryError>>({ status: 409 })
    )
    await expect(unavailable.reopenIfUMPAbsent(user)).rejects.toEqual(
      expect.objectContaining<Partial<RegistrationRecoveryError>>({ status: 503 })
    )
    await expect(UserService.getUserById(user.id)).resolves.toMatchObject({
      registrationStatus: 'active'
    })
  })

  it('returns a fail-closed support response without changing registration state', async () => {
    const user = await UserService.createUser('1'.repeat(64))
    jest
      .spyOn(registrationRecoveryService, 'reopenIfUMPAbsent')
      .mockRejectedValue(
        new RegistrationRecoveryError(
          'Verified UMP lookup was indeterminate; registration was not reopened.',
          503
        )
      )
    const res = mockResponse()

    await AdminController.reopenRegistration(
      { body: { presentationKey: user.presentationKey } } as any,
      res
    )

    expect(res.status).toHaveBeenCalledWith(503)
    expect(res.json).toHaveBeenCalledWith({
      message: 'Verified UMP lookup was indeterminate; registration was not reopened.'
    })
    await expect(UserService.getUserById(user.id)).resolves.toMatchObject({
      registrationStatus: 'active'
    })
  })
})
