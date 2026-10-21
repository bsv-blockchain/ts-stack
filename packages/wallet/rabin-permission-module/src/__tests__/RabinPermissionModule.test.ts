import { CachedKeyDeriver, PrivateKey, type WalletEncryptArgs } from '@bsv/sdk'
import { createRabinModule, RabinPermissionModule } from '../index.js'

const GENERATOR = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
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
  method = 'encrypt',
  originator = 'app.example'
): Promise<{ ciphertext: number[] }> =>
  module.handleRequest!({ method, args: requestArgs, originator }, next) as Promise<{
    ciphertext: number[]
  }>

const refusingDeriver = (): { derivePrivateKey: () => never; calls: number } => {
  const state = {
    calls: 0,
    derivePrivateKey: (): never => {
      state.calls += 1
      throw new Error('derivation must not run')
    }
  }
  return state
}

describe('RabinPermissionModule', () => {
  it('exports the factory, capability and harmless legacy hooks', async () => {
    const module = createRabinModule({ keyDeriver: new CachedKeyDeriver(new PrivateKey(4)) })
    expect(module).toBeInstanceOf(RabinPermissionModule)
    expect(module.capabilities).toEqual({ 'brc206-rabin': 'encrypt' })
    const request = {
      method: 'encrypt',
      args: args(),
      originator: 'app.example'
    }
    await expect(module.onRequest(request)).resolves.toEqual({ args: request.args })
    await expect(module.onResponse({ ciphertext: [1] })).resolves.toEqual({ ciphertext: [1] })
  })

  it('rejects decrypt and every method other than encrypt', async () => {
    const deriver = refusingDeriver()
    const module = new RabinPermissionModule({ keyDeriver: deriver })
    await expect(execute(module, args(), 'decrypt')).rejects.toThrow('square-root oracle')
    for (const method of ['getPublicKey', 'createSignature', 'createHmac', 'signAction']) {
      await expect(execute(module, args(), method)).rejects.toThrow('not permitted')
    }
    expect(deriver.calls).toBe(0)
  })

  it('rejects grammar, length, plaintext and counterparty mistakes before derivation', async () => {
    const deriver = refusingDeriver()
    const module = new RabinPermissionModule({ keyDeriver: deriver })
    const rejected: Array<Partial<WalletEncryptArgs>> = [
      { protocolID: [0, 'p rabin sign 1024 rabin oracle feed'] },
      { protocolID: [0, 'p rabin decrypt 2048 rabin oracle feed'] },
      { protocolID: [0, 'p rabin key 2048 ab'] },
      { protocolID: [0, `p rabin sign 4096 ${'a'.repeat(383)}`] },
      { protocolID: [0, 'p rabin key 2048 abcd protocol'] },
      {
        protocolID: [
          3,
          'p rabin key 2048 rabin oracle feed'
        ] as unknown as WalletEncryptArgs['protocolID']
      },
      { protocolID: [0, 1] as unknown as WalletEncryptArgs['protocolID'] },
      { protocolID: 'p rabin' as unknown as WalletEncryptArgs['protocolID'] },
      { keyID: '' },
      { keyID: 'x'.repeat(801) },
      { plaintext: [1] },
      { plaintext: [256] as unknown as number[] },
      { plaintext: Array.from({ length: 65537 }, () => 1) },
      { counterparty: '02' + 'ff'.repeat(32) },
      { counterparty: '0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798' },
      { counterparty: 'not-a-key' },
      { identityKey: true } as Partial<WalletEncryptArgs>,
      { forSelf: true } as Partial<WalletEncryptArgs>,
      { seekPermission: 'yes' as unknown as boolean },
      { privilegedReason: 'notes', plaintext: [256] } as Partial<WalletEncryptArgs>
    ]
    for (const override of rejected) {
      await expect(execute(module, args(override))).rejects.toThrow('Rabin:')
    }
    expect(deriver.calls).toBe(0)
  })

  it('requires authorization before derivation and scopes level 2 grants', async () => {
    const deriver = refusingDeriver()
    let prompts = 0
    const module = new RabinPermissionModule({
      keyDeriver: deriver,
      authorize: async request => {
        prompts += 1
        expect(request.operation).toBe('sign')
        expect(request.modulusBits).toBe(2048)
        return request.counterparty !== GENERATOR
      }
    })
    const sign = args({
      protocolID: [2, 'p rabin sign 2048 rabin oracle feed'],
      plaintext: [9],
      counterparty: 'self'
    })
    await expect(execute(module, { ...sign, seekPermission: false })).rejects.toThrow(
      'seekPermission is false'
    )
    await expect(execute(module, { ...sign, counterparty: GENERATOR })).rejects.toThrow(
      'user denied permission'
    )
    expect(prompts).toBe(1)
    expect(deriver.calls).toBe(0)
    module.dispose()
    await expect(execute(module, { ...sign, seekPermission: false })).rejects.toThrow(
      'seekPermission is false'
    )
  })

  it('fails closed for privileged requests and literal authorization verdicts', async () => {
    const deriver = refusingDeriver()
    const module = new RabinPermissionModule({
      keyDeriver: deriver,
      authorize: async () => true
    })
    await expect(
      execute(module, args({ privileged: true, privilegedReason: 'oracle key' }))
    ).rejects.toThrow('privileged key derivation is unavailable')
    const coercive = new RabinPermissionModule({
      keyDeriver: deriver,
      authorize: async () => 'yes' as unknown as boolean,
      privilegedKeyDeriver: async () => new CachedKeyDeriver(new PrivateKey(5))
    })
    await expect(
      execute(coercive, args({ privileged: true, privilegedReason: 'oracle key' }))
    ).rejects.toThrow('user denied permission')
    await expect(
      execute(coercive, args({ privileged: true, privilegedReason: 'no' }))
    ).rejects.toThrow('privilegedReason')
    expect(deriver.calls).toBe(0)
  })

  it('stops derivation when the module is locked while resolving a privileged deriver', async () => {
    const deriver = refusingDeriver()
    const module = new RabinPermissionModule({
      keyDeriver: deriver,
      authorize: async () => true,
      privilegedKeyDeriver: async () => {
        module.lock()
        return new CachedKeyDeriver(new PrivateKey(6))
      }
    })
    await expect(
      execute(module, args({ privileged: true, privilegedReason: 'oracle key' }))
    ).rejects.toThrow('locked during key generation')
    expect(deriver.calls).toBe(0)
  })

  it('caps the authorization queue and the key-generation queue', async () => {
    const pending: Array<(value: boolean) => void> = []
    const module = new RabinPermissionModule({
      keyDeriver: refusingDeriver(),
      authorize: () =>
        new Promise<boolean>(resolve => {
          pending.push(resolve)
        })
    })
    const requests = Array.from({ length: 64 }, (_unused, index) =>
      execute(
        module,
        args({
          protocolID: [1, 'p rabin key 2048 rabin oracle feed'],
          keyID: `slot ${index}`
        })
      )
    )
    await Promise.resolve()
    await expect(
      execute(
        module,
        args({ protocolID: [1, 'p rabin key 2048 rabin oracle feed'], keyID: 'overflow' })
      )
    ).rejects.toThrow('authorization queue is full')
    for (const resolve of pending) resolve(false)
    await expect(Promise.all(requests)).rejects.toThrow('user denied permission')

    let started: () => void = () => undefined
    const startedPromise = new Promise<void>(resolve => {
      started = resolve
    })
    let stop: () => void = () => undefined
    const stopGate = new Promise<void>(resolve => {
      stop = resolve
    })
    let privilegedCalls = 0
    const queued = new RabinPermissionModule({
      keyDeriver: refusingDeriver(),
      maxInflightKeygens: 1,
      authorize: async () => true,
      privilegedKeyDeriver: async () => {
        privilegedCalls += 1
        started()
        await stopGate
        throw new Error('stop')
      }
    })
    const first = execute(
      queued,
      args({ privileged: true, privilegedReason: 'oracle key', keyID: 'one' })
    )
    await startedPromise
    await expect(
      execute(queued, args({ privileged: true, privilegedReason: 'oracle key', keyID: 'two' }))
    ).rejects.toThrow('key generation queue is full')
    const shared = execute(
      queued,
      args({ privileged: true, privilegedReason: 'oracle key', keyID: 'one' })
    )
    stop()
    await expect(first).rejects.toThrow('stop')
    await expect(shared).rejects.toThrow('stop')
    expect(privilegedCalls).toBe(1)
  })

  it('rejects unsafe option and request shapes', async () => {
    expect(() => new RabinPermissionModule({} as never)).toThrow('keyDeriver')
    expect(
      () =>
        new RabinPermissionModule({
          keyDeriver: new CachedKeyDeriver(new PrivateKey(7)),
          authorizationTTL: 0
        })
    ).toThrow('authorizationTTL')
    expect(
      () =>
        new RabinPermissionModule({
          keyDeriver: new CachedKeyDeriver(new PrivateKey(7)),
          authorize: true as never
        })
    ).toThrow('authorize must be a function')
    expect(
      () =>
        new RabinPermissionModule({
          keyDeriver: new CachedKeyDeriver(new PrivateKey(7)),
          maxCachedKeys: 0
        })
    ).toThrow('maxCachedKeys')
    const module = new RabinPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(7))
    })
    const inherited = Object.create({ plaintext: [] })
    await expect(
      module.handleRequest!({ method: 'encrypt', args: inherited, originator: 'app.example' }, next)
    ).rejects.toThrow('plain data object')
    await expect(
      module.handleRequest!(
        { method: 'encrypt', args: args(), originator: 'app.example\u0000' },
        next
      )
    ).rejects.toThrow('originator')
    await expect(
      module.handleRequest!({ method: 'encrypt', args: args(), originator: '' }, next)
    ).rejects.toThrow('originator is required')
  })
})
