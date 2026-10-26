import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KeyDeriver, PrivateKey } from '@bsv/sdk'
import * as KeyGenerator from '../generate-private-key'
import * as ServerWalletModule from '../server-wallet'
import { ServerWalletManager, createServerWalletHandler } from '../server-wallet-manager'

const ENV_VAR = 'SIMPLE_SERVER_WALLET_BEHAVIOR_KEY'

function keyPair(): { privateKey: string; identityKey: string } {
  const privateKey = PrivateKey.fromRandom().toHex()
  return { privateKey, identityKey: new KeyDeriver(PrivateKey.fromHex(privateKey)).identityKey }
}

describe('ServerWalletManager key and initialization lifecycle', () => {
  let directory: string
  let keyFile: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'simple-server-wallet-behavior-'))
    keyFile = join(directory, 'wallet.json')
    delete process.env[ENV_VAR]
  })

  afterEach(() => {
    delete process.env[ENV_VAR]
    jest.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
  })

  it.each([
    [{ envVar: 'invalid-name' }, 'environment variable'],
    [{ network: 'regtest' as any }, 'wallet network'],
    [{ defaultRequestSatoshis: 0 }, 'positive safe integer'],
    [{ defaultRequestSatoshis: Number.MAX_SAFE_INTEGER + 1 }, 'positive safe integer'],
    [{ requestMemo: '' }, 'between 1 and 500'],
    [{ requestMemo: 'é'.repeat(251) }, 'between 1 and 500']
  ])('rejects invalid configuration %o', (config, expected) => {
    expect(() => new ServerWalletManager({ ...config, keyFile })).toThrow(expected)
  })

  it('generates, persists, caches, and resets a wallet exactly once', async () => {
    const keys = keyPair()
    const wallet = { getIdentityKey: jest.fn(() => keys.identityKey) }
    jest.spyOn(KeyGenerator, 'generatePrivateKey').mockReturnValue(keys.privateKey)
    const create = jest
      .spyOn(ServerWalletModule.ServerWallet, 'create')
      .mockResolvedValue(wallet as any)
    const manager = new ServerWalletManager({
      keyFile,
      network: 'testnet',
      storageUrl: 'https://store.example'
    })

    const [first, second] = await Promise.all([manager.getWallet(), manager.getWallet()])

    expect(first).toBe(wallet)
    expect(second).toBe(wallet)
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith({
      privateKey: keys.privateKey,
      network: 'testnet',
      storageUrl: 'https://store.example'
    })
    expect(JSON.parse(readFileSync(keyFile, 'utf8'))).toEqual(keys)
    expect(manager.getStatus()).toEqual({ saved: true, identityKey: keys.identityKey })

    manager.reset()
    expect(manager.getStatus()).toEqual({ saved: false, identityKey: null })
  })

  it('uses a valid environment key without reading or persisting the key file', async () => {
    const keys = keyPair()
    process.env[ENV_VAR] = keys.privateKey
    writeFileSync(keyFile, '{corrupt secret', { mode: 0o600 })
    const wallet = { getIdentityKey: jest.fn(() => keys.identityKey) }
    const create = jest
      .spyOn(ServerWalletModule.ServerWallet, 'create')
      .mockResolvedValue(wallet as any)

    await expect(new ServerWalletManager({ envVar: ENV_VAR, keyFile }).getWallet()).resolves.toBe(
      wallet
    )
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ privateKey: keys.privateKey }))
    expect(readFileSync(keyFile, 'utf8')).toBe('{corrupt secret')
  })

  it('clears a failed initialization so a corrected key can be retried', async () => {
    const keys = keyPair()
    process.env[ENV_VAR] = '0'.repeat(64)
    const wallet = { getIdentityKey: jest.fn(() => keys.identityKey) }
    const create = jest
      .spyOn(ServerWalletModule.ServerWallet, 'create')
      .mockResolvedValue(wallet as any)
    const manager = new ServerWalletManager({ envVar: ENV_VAR, keyFile })

    await expect(manager.getWallet()).rejects.toThrow('Server wallet key is invalid')
    process.env[ENV_VAR] = keys.privateKey
    await expect(manager.getWallet()).resolves.toBe(wallet)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['array', []],
    ['extra property', { ...keyPair(), extra: 'secret' }],
    ['invalid private key', { privateKey: 'z'.repeat(64), identityKey: 'x' }],
    ['zero private key', { privateKey: '0'.repeat(64), identityKey: '00' }],
    ['out-of-range private key', { privateKey: 'f'.repeat(64), identityKey: 'x' }],
    ['identity mismatch', { privateKey: keyPair().privateKey, identityKey: keyPair().identityKey }]
  ])('rejects persisted state with a %s', (_name, value) => {
    writeFileSync(keyFile, JSON.stringify(value), { mode: 0o600 })
    expect(() => new ServerWalletManager({ keyFile }).getStatus()).toThrow(
      'Stored server wallet key is invalid'
    )
  })
})

describe('server wallet handler authorized state transitions', () => {
  let directory: string
  let keyFile: string
  let keys: ReturnType<typeof keyPair>
  let wallet: any
  let client: { listOutputs: jest.Mock }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'simple-server-wallet-handler-'))
    keyFile = join(directory, 'wallet.json')
    keys = keyPair()
    process.env[ENV_VAR] = keys.privateKey
    client = {
      listOutputs: jest.fn().mockResolvedValue({
        totalOutputs: 3,
        outputs: [
          { outpoint: `${'a'.repeat(64)}.0`, satoshis: 5, spendable: true, lockingScript: '51' },
          { outpoint: `${'b'.repeat(64)}.1`, satoshis: 7, spendable: false, lockingScript: '51' },
          { outpoint: `${'c'.repeat(64)}.2`, satoshis: 11, spendable: true, lockingScript: '51' }
        ]
      })
    }
    wallet = {
      getIdentityKey: jest.fn(() => keys.identityKey),
      getStatus: jest.fn(() => ({ connected: true })),
      getClient: jest.fn(() => client),
      createPaymentRequest: jest.fn(({ satoshis, memo }) => ({ satoshis, memo })),
      receivePayment: jest.fn().mockResolvedValue(undefined)
    }
    jest.spyOn(ServerWalletModule.ServerWallet, 'create').mockResolvedValue(wallet)
  })

  afterEach(() => {
    delete process.env[ENV_VAR]
    jest.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
  })

  function handler() {
    return createServerWalletHandler({
      envVar: ENV_VAR,
      keyFile,
      defaultRequestSatoshis: 123,
      requestMemo: 'Bounded funding request',
      authorize: async request =>
        request.headers?.get('authorization') === `Bearer ${request.action}`
    })
  }

  function request(action: string, suffix = '') {
    return {
      url: `https://wallet.example/api/server-wallet?action=${action}${suffix}`,
      headers: new Headers({ authorization: `Bearer ${action}` })
    }
  }

  it('serves create, request, balance, and projected outputs without exposing wallet internals', async () => {
    const routes = handler()
    const created = await routes.GET?.(request('create'))
    expect(created.status).toBe(200)
    await expect(created.json()).resolves.toMatchObject({
      success: true,
      serverIdentityKey: keys.identityKey,
      status: { connected: true }
    })

    const paymentRequest = await routes.GET?.(request('request', '&satoshis=456'))
    await expect(paymentRequest.json()).resolves.toMatchObject({
      success: true,
      paymentRequest: { satoshis: 456, memo: 'Bounded funding request' }
    })

    const balance = await routes.GET?.(request('balance', '&basket=payments'))
    await expect(balance.json()).resolves.toEqual({
      success: true,
      basket: 'payments',
      totalOutputs: 3,
      totalSatoshis: 23,
      spendableOutputs: 2,
      spendableSatoshis: 16
    })

    const outputs = await routes.GET?.(request('outputs', '&basket=payments'))
    await expect(outputs.json()).resolves.toMatchObject({
      success: true,
      basket: 'payments',
      outputs: [
        { outpoint: `${'a'.repeat(64)}.0`, satoshis: 5, spendable: true },
        { outpoint: `${'b'.repeat(64)}.1`, satoshis: 7, spendable: false },
        { outpoint: `${'c'.repeat(64)}.2`, satoshis: 11 }
      ]
    })
    expect(client.listOutputs).toHaveBeenNthCalledWith(2, {
      basket: 'payments',
      include: 'locking scripts'
    })
  })

  it('uses the bounded default payment amount and rejects ambiguous numeric text', async () => {
    const routes = handler()
    const defaulted = await routes.GET?.(request('request'))
    expect(defaulted.status).toBe(200)
    expect(wallet.createPaymentRequest).toHaveBeenCalledWith({
      satoshis: 123,
      memo: 'Bounded funding request'
    })

    for (const value of ['0', '01', '1e3', '9007199254740992']) {
      const response = await routes.GET?.(request('request', `&satoshis=${value}`))
      expect(response.status).toBe(500)
      await expect(response.json()).resolves.toEqual({
        success: false,
        error: 'Server wallet request failed'
      })
    }
    expect(wallet.createPaymentRequest).toHaveBeenCalledTimes(1)
  })

  it('rejects inherited and accessor-backed wallet output results', async () => {
    const routes = handler()
    const inheritedResult = Object.create({
      totalOutputs: 1,
      outputs: [{ outpoint: `${'a'.repeat(64)}.0`, satoshis: 50, spendable: true }]
    })
    client.listOutputs.mockResolvedValueOnce(inheritedResult)

    expect((await routes.GET!(request('balance'))).status).toBe(500)

    const getter = jest.fn(() => [
      { outpoint: `${'a'.repeat(64)}.0`, satoshis: 50, spendable: true }
    ])
    const accessorResult = Object.defineProperty({ totalOutputs: 1 }, 'outputs', {
      get: getter,
      enumerable: true
    })
    client.listOutputs.mockResolvedValueOnce(accessorResult)

    expect((await routes.GET!(request('outputs'))).status).toBe(500)
    expect(getter).not.toHaveBeenCalled()

    client.listOutputs.mockResolvedValueOnce({
      totalOutputs: 1,
      outputs: [
        Object.create({
          outpoint: `${'a'.repeat(64)}.0`,
          satoshis: 50,
          spendable: true,
          lockingScript: '51'
        })
      ]
    })
    expect((await routes.GET!(request('outputs'))).status).toBe(500)
  })

  it('receives a bound payment with a default output index', async () => {
    const routes = handler()
    const response = await routes.POST?.({
      ...request('receive'),
      json: async () => ({
        tx: [1, 2, 3],
        senderIdentityKey: keys.identityKey,
        derivationPrefix: 'prefix',
        derivationSuffix: 'suffix'
      })
    })

    expect(response.status).toBe(200)
    expect(wallet.receivePayment).toHaveBeenCalledWith({
      tx: [1, 2, 3],
      senderIdentityKey: keys.identityKey,
      derivationPrefix: 'prefix',
      derivationSuffix: 'suffix',
      outputIndex: 0,
      description: 'Desktop wallet funding'
    })
  })

  it('rejects sparse payment bytes before the wallet call', async () => {
    const routes = handler()
    const sparseTransaction: number[] = []
    sparseTransaction.length = 1
    const response = await routes.POST?.({
      ...request('receive'),
      json: async () => ({
        tx: sparseTransaction,
        senderIdentityKey: keys.identityKey,
        derivationPrefix: 'prefix',
        derivationSuffix: 'suffix'
      })
    })

    expect(response.status).toBe(500)
    expect(wallet.receivePayment).not.toHaveBeenCalled()
  })

  it('rejects missing receive fields and unknown actions without mutating the wallet', async () => {
    const routes = handler()
    const missing = await routes.POST?.({
      ...request('receive'),
      json: async () => ({ tx: [1], senderIdentityKey: keys.identityKey })
    })
    expect(missing.status).toBe(400)
    expect(wallet.receivePayment).not.toHaveBeenCalled()

    const unknown = await routes.GET?.({
      url: 'https://wallet.example/api/server-wallet?action=unknown',
      headers: new Headers({ authorization: 'Bearer unknown' })
    })
    expect(unknown.status).toBe(400)
    await expect(unknown.json()).resolves.toMatchObject({ error: 'Unknown server wallet action' })

    const unknownPost = await routes.POST?.({
      url: 'https://wallet.example/api/server-wallet?action=unknown',
      headers: new Headers({ authorization: 'Bearer unknown' }),
      json: async () => ({})
    })
    expect(unknownPost.status).toBe(400)
    await expect(unknownPost.json()).resolves.toMatchObject({
      error: 'Unknown server wallet action'
    })
  })
})
