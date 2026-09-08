import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { db } from '../db/knex'
import {
  DemoAccountService,
  isDemoAuthEnabled,
  validateDemoAccountConfig
} from '../services/DemoAccountService'
import { DemoPhoneAuthMethod } from '../auth-methods/DemoPhoneAuthMethod'
import {
  getAuthMethodInstance,
  getSupportedAuthMethodTypes
} from '../auth-methods/AuthMethodFactory'
import { UserService } from '../services/UserService'
import app from '../app'
import type { Request, Response } from 'express'
import { DemoAccountController } from '../controllers/DemoAccountController'

const alias = '+12065550101'
const key = 'a1'.repeat(32)
const anotherKey = 'b2'.repeat(32)
const demo = new DemoPhoneAuthMethod()
const expiry = () => Date.now() + 86400000

describe('admin-provisioned demo identities', () => {
  const originalDemoKey = process.env.WAB_DEMO_AUTH_SECRET
  const originalAdminToken = process.env.WAB_ADMIN_TOKEN

  beforeEach(async () => {
    process.env.WAB_DEMO_AUTH_SECRET = randomBytes(32).toString('hex')
    await db('demo_accounts').del()
  })

  afterAll(() => {
    if (originalDemoKey === undefined) delete process.env.WAB_DEMO_AUTH_SECRET
    else process.env.WAB_DEMO_AUTH_SECRET = originalDemoKey
    if (originalAdminToken === undefined) delete process.env.WAB_ADMIN_TOKEN
    else process.env.WAB_ADMIN_TOKEN = originalAdminToken
  })

  it('is disabled by default and rejects weak configuration', () => {
    delete process.env.WAB_DEMO_AUTH_SECRET
    expect(isDemoAuthEnabled()).toBe(false)
    expect(getSupportedAuthMethodTypes()).not.toContain('DemoPhone')
    expect(() => getAuthMethodInstance('DemoPhone')).toThrow('Unsupported auth method')
    process.env.WAB_DEMO_AUTH_SECRET = 'short'
    expect(() => validateDemoAccountConfig()).toThrow('at least 32')
  })

  it('issues a code only through provision and verifies repeated demo sign-ins', async () => {
    const issued = await DemoAccountService.provision(alias, 'App review', expiry())
    expect(issued.code).toMatch(/^\d{6}$/)
    expect(issued.methodType).toBe('DemoPhone')
    const stored = await db('demo_accounts').where({ id: issued.id }).first()
    expect(stored.codeDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(stored).not.toHaveProperty('code')
    expect(stored.codeDigest).not.toBe(issued.code)
    expect(await DemoAccountService.list()).toEqual([
      {
        id: issued.id,
        phoneNumber: alias,
        label: 'App review',
        expiresAtEpochMs: issued.expiresAtEpochMs,
        revoked: false,
        locked: false
      }
    ])
    expect(await demo.completeAuth(key, { phoneNumber: alias, otp: issued.code })).toMatchObject({
      success: true
    })
    expect(
      await demo.completeAuth(anotherKey, { phoneNumber: alias, otp: issued.code })
    ).toMatchObject({ success: true })
    expect(getSupportedAuthMethodTypes()[0]).toBe('TwilioPhone')
  })

  it('rejects unknown, malformed, expired, revoked and disabled access', async () => {
    expect(await DemoAccountService.verify(alias, '000000')).toBe(false)
    const issued = await DemoAccountService.provision(alias, 'App review', expiry())
    expect(await DemoAccountService.verify(alias, null)).toBe(false)
    expect(await DemoAccountService.verify(alias, '12345')).toBe(false)
    await db('demo_accounts')
      .where({ id: issued.id })
      .update({ expiresAtEpochMs: Date.now() - 1 })
    expect(await DemoAccountService.verify(alias, issued.code)).toBe(false)
    const rotated = await DemoAccountService.rotate(issued.id, expiry())
    expect(await DemoAccountService.verify(alias, rotated.code)).toBe(true)
    await DemoAccountService.revoke(issued.id)
    expect(await DemoAccountService.verify(alias, rotated.code)).toBe(false)
    expect((await DemoAccountService.list())[0]?.revoked).toBe(true)
    delete process.env.WAB_DEMO_AUTH_SECRET
    expect(await DemoAccountService.verify(alias, rotated.code)).toBe(false)
  })

  it('locks after five incorrect guesses across method instances, without resetting on start or success', async () => {
    const issued = await DemoAccountService.provision(alias, 'App review', expiry())
    const wrong = issued.code === '123456' ? '654321' : '123456'
    const secondInstance = new DemoPhoneAuthMethod()
    for (let index = 0; index < 4; index++) {
      expect(
        await secondInstance.completeAuth(key, { phoneNumber: alias, otp: wrong })
      ).toMatchObject({ success: false })
    }
    expect(await DemoAccountService.verify(alias, issued.code)).toBe(true)
    await demo.startAuth(key, { phoneNumber: alias })
    expect(await DemoAccountService.verify(alias, wrong)).toBe(false)
    expect(await DemoAccountService.verify(alias, issued.code)).toBe(false)
    expect((await DemoAccountService.list())[0]?.locked).toBe(true)
    const rotated = await DemoAccountService.rotate(issued.id, expiry())
    expect(await DemoAccountService.verify(alias, rotated.code)).toBe(true)
    expect((await db('demo_accounts').where({ id: issued.id }).first()).failedAttempts).toBe(0)
  })

  it('bounds provisioning and retains identity on rotation', async () => {
    await expect(DemoAccountService.provision('bad', 'Review', expiry())).rejects.toThrow(
      'canonical'
    )
    await expect(DemoAccountService.provision(alias, '', expiry())).rejects.toThrow('label')
    await expect(DemoAccountService.provision(alias, 'Review', Date.now() - 1)).rejects.toThrow(
      '30 days'
    )
    await expect(
      DemoAccountService.provision(alias, 'Review', Date.now() + 31 * 86400000)
    ).rejects.toThrow('30 days')
    const issued = await DemoAccountService.provision(alias, 'Review', expiry())
    await expect(DemoAccountService.provision(alias, 'Other', expiry())).rejects.toThrow(
      'already exists'
    )
    await expect(DemoAccountService.rotate('missing', expiry())).rejects.toThrow('not found')
    await expect(DemoAccountService.revoke('missing')).rejects.toThrow('not found')
    const stored = await db('demo_accounts').where({ id: issued.id }).first()
    const rotated = await DemoAccountService.rotate(issued.id, expiry())
    const after = await db('demo_accounts').where({ id: issued.id }).first()
    expect(after.id).toBe(stored.id)
    expect(after.phoneNumber).toBe(stored.phoneNumber)
    expect(await DemoAccountService.verify(alias, rotated.code)).toBe(true)
  })

  it('binds stored credentials to the account and deployment key', async () => {
    const first = await DemoAccountService.provision(alias, 'First', expiry())
    const second = await DemoAccountService.provision('+12065550102', 'Second', expiry())
    const stored = await db('demo_accounts').where({ id: first.id }).first()
    await db('demo_accounts').where({ id: second.id }).update({ codeDigest: stored.codeDigest })
    expect(await DemoAccountService.verify('+12065550102', first.code)).toBe(false)
    process.env.WAB_DEMO_AUTH_SECRET = randomBytes(32).toString('hex')
    expect(await DemoAccountService.verify(alias, first.code)).toBe(false)
    const rotated = await DemoAccountService.rotate(first.id, expiry())
    expect(await DemoAccountService.verify(alias, rotated.code)).toBe(true)
  })

  it('validates admin operations, rotates and revokes access, and returns bounded failures', async () => {
    const manage = async (body: unknown) => {
      const result: { status: number; body: unknown } = { status: 200, body: undefined }
      const response = {
        setHeader: jest.fn(),
        status: (status: number) => {
          result.status = status
          return response
        },
        json: (value: unknown) => {
          result.body = value
          return response
        }
      }
      await DemoAccountController.manage({ body } as Request, response as unknown as Response)
      expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store')
      return result
    }
    expect((await manage(null)).status).toBe(400)
    expect((await manage({ action: 'provision', phoneNumber: alias })).status).toBe(400)
    expect((await manage({ action: 'rotate', id: 'invalid' })).status).toBe(400)
    const issued = await DemoAccountService.provision(alias, 'Operator test', expiry())
    expect((await manage({ action: 'unknown', id: issued.id })).status).toBe(400)
    expect((await manage({ action: 'list' })).body).toEqual({
      accounts: await DemoAccountService.list()
    })
    expect((await manage({ action: 'rotate', id: issued.id, expiresAtEpochMs: 0 })).status).toBe(
      400
    )
    const rotated = await manage({ action: 'rotate', id: issued.id, expiresAtEpochMs: expiry() })
    expect(rotated.status).toBe(200)
    expect(await DemoAccountService.verify(alias, (rotated.body as { code: string }).code)).toBe(
      true
    )
    expect((await manage({ action: 'revoke', id: issued.id })).body).toEqual({ success: true })
    expect(await DemoAccountService.verify(alias, (rotated.body as { code: string }).code)).toBe(
      false
    )
    const failure = jest
      .spyOn(DemoAccountService, 'list')
      .mockRejectedValueOnce(new Error('private database detail'))
    try {
      expect(await manage({ action: 'list' })).toEqual({
        status: 500,
        body: { message: 'An internal error occurred.' }
      })
    } finally {
      failure.mockRestore()
    }
    delete process.env.WAB_DEMO_AUTH_SECRET
    expect((await manage({ action: 'list' })).status).toBe(404)
    await expect(DemoAccountService.provision(alias, 'Disabled', expiry())).rejects.toThrow(
      'disabled'
    )
  })

  it('requires admin authorization and keeps a matching real SMS identity separate through HTTP', async () => {
    const server: Server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const post = (path: string, body: object, token?: string) =>
      fetch(url + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify(body)
      })
    try {
      delete process.env.WAB_ADMIN_TOKEN
      expect((await post('/admin/demo-accounts', { action: 'list' })).status).toBe(404)
      process.env.WAB_ADMIN_TOKEN = randomBytes(32).toString('hex')
      expect((await post('/admin/demo-accounts', { action: 'list' }, 'wrong')).status).toBe(401)
      const response = await post(
        '/admin/demo-accounts',
        {
          action: 'provision',
          phoneNumber: alias,
          label: 'Store review',
          expiresAtEpochMs: expiry()
        },
        process.env.WAB_ADMIN_TOKEN
      )
      expect(response.status).toBe(201)
      expect(response.headers.get('cache-control')).toBe('no-store')
      const issued = (await response.json()) as { code: string }
      expect(await (await fetch(url + '/demo/info')).json()).toMatchObject({
        supportedAuthMethods: ['DemoPhone']
      })
      const real = await UserService.createUser('cc'.repeat(32))
      await UserService.linkAuthMethod(real.id, 'TwilioPhone', alias)
      expect((await post('/demo/auth/start', { methodType: 'OtherMethod' })).status).toBe(400)
      // Exercise the fixed method name sent by existing mobile phone interactors.
      const input = {
        methodType: 'TwilioPhone',
        presentationKey: key,
        payload: { phoneNumber: alias, otp: issued.code }
      }
      expect(await (await post('/demo/auth/start', input)).json()).toMatchObject({ success: true })
      expect(await (await post('/demo/auth/complete', input)).json()).toMatchObject({
        success: true,
        presentationKey: key,
        accountStatus: 'new-user'
      })
      expect(
        await (await post('/demo/auth/complete', { ...input, presentationKey: anotherKey })).json()
      ).toMatchObject({ success: true, presentationKey: key, accountStatus: 'existing-user' })
      expect((await UserService.findUserByConfig('TwilioPhone', alias))?.presentationKey).toBe(
        real.presentationKey
      )
      expect((await UserService.findUserByConfig('DemoPhone', alias))?.presentationKey).toBe(key)
      delete process.env.WAB_DEMO_AUTH_SECRET
      expect((await fetch(url + '/demo/info')).status).toBe(404)
      expect((await post('/demo/auth/complete', input)).status).toBe(404)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      )
    }
  })
})
