import type { Response } from 'express'
import registerDevice, {
  MAX_DEVICE_ID_LENGTH,
  MAX_FCM_TOKEN_LENGTH,
  type RegisterDeviceRequest
} from '../registerDevice.js'
import listDevices, { MAX_DEVICE_OFFSET, MAX_DEVICE_PAGE_SIZE } from '../listDevices.js'
import { runtimeDeps } from '../../runtimeDeps.js'

function response(): jest.Mocked<Response> {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis()
  } as unknown as jest.Mocked<Response>
}

function registerRequest(
  body: RegisterDeviceRequest['body'],
  identityKey: string | undefined = 'identity-key'
): RegisterDeviceRequest {
  return {
    auth: identityKey == null ? undefined : { identityKey },
    body
  } as RegisterDeviceRequest
}

describe('device routes', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it.each([
    [{ fcmToken: 'x'.repeat(MAX_FCM_TOKEN_LENGTH + 1) }, 'ERR_INVALID_FCM_TOKEN'],
    [
      {
        fcmToken: 'token',
        deviceId: 'x'.repeat(MAX_DEVICE_ID_LENGTH + 1)
      },
      'ERR_INVALID_DEVICE_ID'
    ],
    [{ fcmToken: 'token', platform: 'desktop' }, 'ERR_INVALID_PLATFORM']
  ] as const)('rejects invalid registration input', async (body, code) => {
    const res = response()
    await registerDevice.func(registerRequest(body as RegisterDeviceRequest['body']), res)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code }))
  })

  it('does not let an identity take over an existing delivery token', async () => {
    const first = jest.fn().mockResolvedValue({
      id: 42,
      identity_key: 'different-identity'
    })
    runtimeDeps.knex = jest.fn(() => ({
      select: () => ({
        where: () => ({ first })
      })
    })) as unknown as typeof runtimeDeps.knex
    const res = response()

    await registerDevice.func(registerRequest({ fcmToken: 'token' }), res)

    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'ERR_DEVICE_TOKEN_ALREADY_REGISTERED'
      })
    )
  })

  it('refreshes a token only for its existing owner', async () => {
    const update = jest.fn().mockResolvedValue(1)
    runtimeDeps.knex = jest
      .fn()
      .mockReturnValueOnce({
        select: () => ({
          where: () => ({
            first: jest.fn().mockResolvedValue({ id: 42, identity_key: 'identity-key' })
          })
        })
      })
      .mockReturnValueOnce({
        where: () => ({ update })
      }) as unknown as typeof runtimeDeps.knex
    const res = response()

    await registerDevice.func(
      registerRequest({ fcmToken: 'token', platform: 'web', deviceId: 'browser' }),
      res
    )

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ device_id: 'browser', platform: 'web', active: true })
    )
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'success', deviceId: 42 })
    )
  })

  it('inserts a previously unregistered token', async () => {
    const insert = jest.fn().mockResolvedValue([7])
    runtimeDeps.knex = jest
      .fn()
      .mockReturnValueOnce({
        select: () => ({
          where: () => ({ first: jest.fn().mockResolvedValue(undefined) })
        })
      })
      .mockReturnValueOnce({ insert }) as unknown as typeof runtimeDeps.knex
    const res = response()

    await registerDevice.func(registerRequest({ fcmToken: 'new-token' }), res)

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        identity_key: 'identity-key',
        fcm_token: 'new-token',
        active: true
      })
    )
    expect(res.status).toHaveBeenCalledWith(200)
  })

  it('returns a bounded page with redacted tokens', async () => {
    const offset = jest.fn().mockResolvedValue([
      {
        id: 1,
        deviceId: 'browser',
        platform: 'web',
        fcmToken: 'secret-device-token',
        active: true
      }
    ])
    runtimeDeps.knex = jest.fn(() => ({
      select: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => ({ offset })
          })
        })
      })
    })) as unknown as typeof runtimeDeps.knex
    const res = response()

    await listDevices.func(
      {
        auth: { identityKey: 'identity-key' },
        query: { limit: '10', offset: '20' }
      } as never,
      res
    )

    expect(offset).toHaveBeenCalledWith(20)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'success',
        limit: 10,
        offset: 20,
        devices: [expect.objectContaining({ fcmToken: '...vice-token' })]
      })
    )
  })

  it.each([
    [{ limit: String(MAX_DEVICE_PAGE_SIZE + 1) }, 'ERR_INVALID_LIMIT'],
    [{ limit: '1.5' }, 'ERR_INVALID_LIMIT'],
    [{ offset: String(MAX_DEVICE_OFFSET + 1) }, 'ERR_INVALID_OFFSET'],
    [{ offset: 'not-a-number' }, 'ERR_INVALID_OFFSET']
  ])('bounds device pagination', async (query, code) => {
    const res = response()
    await listDevices.func(
      {
        auth: { identityKey: 'identity-key' },
        query
      } as never,
      res
    )
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code }))
  })
})
