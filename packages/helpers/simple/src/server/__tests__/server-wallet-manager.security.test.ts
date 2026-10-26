import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServerWalletHandler } from '../server-wallet-manager'

describe('server wallet route authorization', () => {
  let directory: string
  let keyFile: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'simple-server-wallet-'))
    keyFile = join(directory, 'wallet.json')
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it.each(['status', 'reset', 'create', 'request', 'balance', 'outputs'])(
    'defaults the %s route closed',
    async action => {
      const handler = createServerWalletHandler()
      const response = await handler.GET?.({
        url: `https://wallet.example/api/server-wallet?action=${action}`
      })

      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toEqual({
        success: false,
        error: 'Server wallet access is not authorized'
      })
    }
  )

  it('denies receive before parsing its request body', async () => {
    const json = jest.fn(async () => ({ transaction: [] }))
    const handler = createServerWalletHandler({ keyFile })
    const response = await handler.POST?.({
      url: 'https://wallet.example/api/server-wallet?action=receive',
      json
    })

    expect(response.status).toBe(403)
    expect(json).not.toHaveBeenCalled()
  })

  it('does not inherit an ambient authorization callback', async () => {
    const ambientAuthorize = jest.fn(async () => true)
    Object.defineProperty(Object.prototype, 'authorize', {
      value: ambientAuthorize,
      configurable: true
    })
    try {
      const handler = createServerWalletHandler()
      const response = await handler.GET?.({
        url: 'https://wallet.example/api/server-wallet?action=reset'
      })

      expect(response.status).toBe(403)
      expect(ambientAuthorize).not.toHaveBeenCalled()
    } finally {
      Reflect.deleteProperty(Object.prototype, 'authorize')
    }
  })

  it('passes policy a null-prototype context without ambient headers', async () => {
    const authorize = jest.fn(async request => {
      expect(Object.getPrototypeOf(request)).toBeNull()
      expect('headers' in request).toBe(false)
      return false
    })
    Object.defineProperty(Object.prototype, 'headers', {
      value: new Headers({ authorization: 'ambient' }),
      configurable: true
    })
    try {
      const handler = createServerWalletHandler({ keyFile, authorize })
      const response = await handler.GET?.({
        url: 'https://wallet.example/api/server-wallet?action=reset'
      })

      expect(response.status).toBe(403)
      expect(authorize).toHaveBeenCalledTimes(1)
    } finally {
      Reflect.deleteProperty(Object.prototype, 'headers')
    }
  })

  it('requires an exact true policy verdict and contains policy failures', async () => {
    for (const authorize of [
      async () => 'yes' as any,
      async () => Promise.reject(new Error('x'))
    ]) {
      const handler = createServerWalletHandler({ keyFile, authorize })
      const response = await handler.GET?.({
        url: 'https://wallet.example/api/server-wallet?action=reset'
      })
      expect(response.status).toBe(403)
    }
  })

  it('allows an authorized reset without exposing or parsing wallet state', async () => {
    writeFileSync(keyFile, '{corrupt', { mode: 0o600 })
    const authorize = jest.fn(async request => request.action === 'reset')
    const handler = createServerWalletHandler({ keyFile, authorize })
    const response = await handler.GET?.({
      url: 'https://wallet.example/api/server-wallet?action=reset',
      headers: new Headers({ authorization: 'Bearer synthetic' })
    })

    expect(response.status).toBe(200)
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'reset', headers: expect.any(Headers) })
    )
  })

  it('redacts persisted-key diagnostics at the route boundary', async () => {
    writeFileSync(keyFile, '{corrupt-secret', { mode: 0o600 })
    const handler = createServerWalletHandler({ keyFile, authorize: async () => true })
    const response = await handler.GET?.({
      url: 'https://wallet.example/api/server-wallet?action=status'
    })

    expect(response.status).toBe(500)
    const body = await response.text()
    expect(body).toContain('Server wallet request failed')
    expect(body).not.toContain('corrupt-secret')
    expect(body).not.toContain(keyFile)
  })
})
