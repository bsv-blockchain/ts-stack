import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PrivateKey, type WalletEncryptArgs } from '@bsv/sdk'
import { RabinPermissionModule } from '../RabinPermissionModule.js'
import type { RabinKeyDeriver } from '../types.js'

const next = async (): Promise<never> => {
  throw new Error('underlying wallet must not be called')
}

const args = (overrides: Partial<WalletEncryptArgs> = {}): WalletEncryptArgs => ({
  protocolID: [0, 'p rabin key 2048 rabin oracle feed'],
  keyID: 'price',
  plaintext: [],
  counterparty: 'self',
  ...overrides
})

const execute = (
  module: RabinPermissionModule,
  requestArgs: WalletEncryptArgs,
  originator = 'app.example'
): Promise<{ ciphertext: number[] }> =>
  module.handleRequest!({ method: 'encrypt', args: requestArgs, originator }, next) as Promise<{
    ciphertext: number[]
  }>

const refusingDeriver = (): RabinKeyDeriver => ({
  derivePrivateKey: () => {
    throw new Error('derivation must not run')
  }
})

const level1 = (keyID: string): WalletEncryptArgs =>
  args({
    protocolID: [1, 'p rabin key 2048 rabin oracle feed'],
    keyID
  })

describe('Rabin permission bounds', () => {
  const seedHex = (
    JSON.parse(readFileSync(join(process.cwd(), 'conformance/vectors.json'), 'utf8')) as {
      keys: Array<{ bits: number; seedHex: string }>
    }
  ).keys.find(key => key.bits === 2048)?.seedHex

  it('rejects malformed options, requests, plaintext and counterparties', async () => {
    expect(() => new RabinPermissionModule(null as never)).toThrow('must be an object')
    expect(() => new RabinPermissionModule([] as never)).toThrow('must be an object')
    expect(
      () =>
        new RabinPermissionModule({
          keyDeriver: refusingDeriver(),
          authorizationTTL: 24 * 60 * 60 * 1000 + 1
        })
    ).toThrow('authorizationTTL')
    expect(
      () =>
        new RabinPermissionModule({
          keyDeriver: refusingDeriver(),
          maxInflightKeygens: 17
        })
    ).toThrow('maxInflightKeygens')
    expect(
      () =>
        new RabinPermissionModule({
          keyDeriver: refusingDeriver(),
          privilegedKeyDeriver: true as never
        })
    ).toThrow('privilegedKeyDeriver must be a function')

    const nullPrototype = Object.create(null) as { keyDeriver: RabinKeyDeriver }
    nullPrototype.keyDeriver = refusingDeriver()
    expect(() => new RabinPermissionModule(nullPrototype)).not.toThrow()

    const hidden = { keyDeriver: refusingDeriver() }
    Object.defineProperty(hidden, 'note', { value: 1, enumerable: false })
    expect(() => new RabinPermissionModule(hidden)).not.toThrow()

    const symbolic = { keyDeriver: refusingDeriver(), [Symbol('extra')]: 1 }
    expect(() => new RabinPermissionModule(symbolic)).toThrow('symbol')

    const accessor = {}
    Object.defineProperty(accessor, 'keyDeriver', {
      enumerable: true,
      get: () => refusingDeriver()
    })
    expect(() => new RabinPermissionModule(accessor as never)).toThrow('accessors')

    const module = new RabinPermissionModule({ keyDeriver: refusingDeriver() })
    await expect(module.handleRequest!(null as never, next)).rejects.toThrow('must be an object')
    await expect(
      module.handleRequest!(
        {
          method: 'encrypt',
          args: args(),
          originator: 'app.example',
          [Symbol('extra')]: 1
        } as never,
        next
      )
    ).rejects.toThrow('symbol')
    const requestAccessor = { method: 'encrypt', originator: 'app.example' }
    Object.defineProperty(requestAccessor, 'args', { enumerable: true, get: () => args() })
    await expect(module.handleRequest!(requestAccessor as never, next)).rejects.toThrow('accessors')
    await expect(
      module.handleRequest!({ method: 'encrypt', args: args(), originator: 1 } as never, next)
    ).rejects.toThrow('originator is required')
    await expect(execute(module, args(), '😀'.repeat(300))).rejects.toThrow('originator')
    await expect(execute(module, args(), 'a'.repeat(1025))).rejects.toThrow('originator')

    const sparse = [1, 2]
    delete sparse[1]
    const rejected: Array<Partial<WalletEncryptArgs>> = [
      { plaintext: new Uint8Array(65_537) as unknown as number[] },
      { plaintext: new Uint8Array([1]) as unknown as number[] },
      { plaintext: 'nope' as unknown as number[] },
      { plaintext: sparse },
      { counterparty: 1 as unknown as WalletEncryptArgs['counterparty'] },
      { counterparty: `02${'0'.repeat(63)}5` },
      { privileged: true, privilegedReason: 1 as unknown as string },
      { privilegedReason: 1 as unknown as string },
      { privileged: true, privilegedReason: 'x'.repeat(4) },
      { privileged: true, privilegedReason: 'x'.repeat(51) }
    ]
    for (const override of rejected) {
      await expect(execute(module, args(override))).rejects.toThrow('Rabin:')
    }
    await expect(
      execute(
        module,
        args({
          privileged: true,
          privilegedReason: 'x'.repeat(50)
        })
      )
    ).rejects.toThrow('no authorization handler')
  })

  it('reuses a fresh grant, expires it, and evicts the oldest of 1024', async () => {
    let prompts = 0
    const module = new RabinPermissionModule({
      keyDeriver: {
        derivePrivateKey: () => {
          throw new Error('stop')
        }
      },
      authorize: async () => {
        prompts += 1
        return true
      }
    })
    await expect(execute(module, level1('a'))).rejects.toThrow('stop')
    await expect(execute(module, level1('a'))).rejects.toThrow('stop')
    expect(prompts).toBe(1)
    for (let index = 0; index < 1023; index++) {
      await expect(execute(module, level1(`k${index}`))).rejects.toThrow('stop')
    }
    expect(prompts).toBe(1024)
    await expect(execute(module, level1('overflow'))).rejects.toThrow('stop')
    expect(prompts).toBe(1025)
    await expect(execute(module, level1('a'))).rejects.toThrow('stop')
    expect(prompts).toBe(1026)

    let expiredPrompts = 0
    const shortLived = new RabinPermissionModule({
      keyDeriver: {
        derivePrivateKey: () => {
          throw new Error('stop')
        }
      },
      authorize: async () => {
        expiredPrompts += 1
        return true
      },
      authorizationTTL: 1
    })
    await expect(execute(shortLived, level1('a'))).rejects.toThrow('stop')
    await new Promise(resolve => setTimeout(resolve, 15))
    await expect(execute(shortLived, level1('a'))).rejects.toThrow('stop')
    expect(expiredPrompts).toBe(2)
  })

  it('deletes a grant that expired behind a still-valid one', async () => {
    let now = 20_000
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      let prompts = 0
      const module = new RabinPermissionModule({
        keyDeriver: {
          derivePrivateKey: () => {
            throw new Error('stop')
          }
        },
        authorize: async () => {
          prompts += 1
          return true
        },
        authorizationTTL: 1_000
      })
      const { counterparty: _counterparty, ...omitted } = level1('early')
      await expect(execute(module, omitted)).rejects.toThrow('stop')
      now = 10_000
      await expect(
        execute(module, { ...level1('late'), counterparty: 'anyone', seekPermission: true })
      ).rejects.toThrow('stop')
      now = 12_000
      await expect(execute(module, { ...level1('late'), counterparty: 'anyone' })).rejects.toThrow(
        'stop'
      )
      expect(prompts).toBe(3)
    } finally {
      spy.mockRestore()
    }
  })

  it('shares one in-flight authorization and ignores a cleared pending entry', async () => {
    let resolve: (value: boolean) => void = () => undefined
    const gate = new Promise<boolean>(done => {
      resolve = done
    })
    let prompts = 0
    const shared = new RabinPermissionModule({
      keyDeriver: refusingDeriver(),
      authorize: () => {
        prompts += 1
        return gate
      }
    })
    const first = execute(shared, level1('shared'))
    await Promise.resolve()
    const second = execute(shared, level1('shared'))
    resolve(false)
    await expect(first).rejects.toThrow('user denied permission')
    await expect(second).rejects.toThrow('user denied permission')
    expect(prompts).toBe(1)

    const cleared = new RabinPermissionModule({
      keyDeriver: refusingDeriver(),
      authorize: async () => {
        cleared.lock()
        return false
      }
    })
    await expect(execute(cleared, level1('cleared'))).rejects.toThrow('user denied permission')
  })

  it('rejects a missing, null, or non-function privileged deriver', async () => {
    const module = new RabinPermissionModule({
      keyDeriver: refusingDeriver(),
      authorize: async () => true,
      privilegedKeyDeriver: async () => null as never
    })
    const privileged = args({ privileged: true, privilegedReason: 'oracle key' })
    await expect(execute(module, privileged)).rejects.toThrow('invalid deriver')
    const invalid = new RabinPermissionModule({
      keyDeriver: refusingDeriver(),
      authorize: async () => true,
      privilegedKeyDeriver: async () => ({ derivePrivateKey: 1 }) as never
    })
    await expect(execute(invalid, privileged)).rejects.toThrow('invalid deriver')
  })

  it('rejects a scalar read after the module locks inside derivation', async () => {
    const module = new RabinPermissionModule({
      keyDeriver: {
        derivePrivateKey: () => {
          module.lock()
          return { toHex: () => 'ab'.repeat(32) } as never
        }
      }
    })
    await expect(execute(module, args())).rejects.toThrow('locked during key generation')
  })

  it('rejects a non-canonical scalar and a non-Error derivation failure', async () => {
    const malformed = new RabinPermissionModule({
      keyDeriver: { derivePrivateKey: () => ({ toHex: () => 'abcd' }) as never }
    })
    await expect(execute(malformed, args())).rejects.toThrow('non-canonical scalar')
    const thrown = new RabinPermissionModule({
      keyDeriver: {
        derivePrivateKey: () => {
          throw 'boom'
        }
      }
    })
    await expect(execute(thrown, args())).rejects.toThrow('key generation failed')
  })

  it('evicts the oldest cached factors and wipes them if locked mid-derivation', async () => {
    expect(seedHex).toMatch(/^[0-9a-f]{64}$/)
    const calls = { count: 0 }
    const deriver: RabinKeyDeriver = {
      derivePrivateKey: () => {
        calls.count += 1
        return new PrivateKey(seedHex ?? '', 'hex', 'be', 'nocheck')
      }
    }
    const cached = new RabinPermissionModule({ keyDeriver: deriver, maxCachedKeys: 1 })
    await execute(cached, args({ keyID: 'a' }))
    await execute(cached, args({ keyID: 'a' }))
    expect(calls.count).toBe(1)
    await execute(cached, args({ keyID: 'b' }))
    expect(calls.count).toBe(2)
    await execute(cached, args({ keyID: 'a' }))
    expect(calls.count).toBe(3)
    cached.dispose()

    const locked = new RabinPermissionModule({ keyDeriver: deriver })
    const subtle = crypto.subtle.sign.bind(crypto.subtle)
    let didLock = false
    const spy = jest
      .spyOn(crypto.subtle, 'sign')
      .mockImplementation(async (algorithm, key, data) => {
        const signature = await subtle(algorithm, key, data)
        if (!didLock) {
          didLock = true
          locked.lock()
        }
        return signature
      })
    try {
      await expect(execute(locked, args({ keyID: 'locked' }))).rejects.toThrow(
        'locked during key generation'
      )
    } finally {
      spy.mockRestore()
    }
    expect(didLock).toBe(true)
  })
})
