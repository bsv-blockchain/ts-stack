import type { WalletInterface } from '@bsv/sdk'
import { StorageClient, Wallet, WalletStorageManager } from '@bsv/wallet-toolbox'
import { describe, expect, it, vi } from 'vitest'
import {
  createDestinationWallet,
  DEFAULT_STORAGE_URL,
  type CliIO,
  defaultFundingDependencies,
  type FundingDependencies,
  fundWallet,
  parseCliArguments,
  type PromptSession,
  runCli
} from './cli.js'

const VALID_PRIVATE_KEY = '1'.padStart(64, '0')

function makeIO(): CliIO & { logs: unknown[][]; errors: unknown[][] } {
  const logs: unknown[][] = []
  const errors: unknown[][] = []
  return {
    logs,
    errors,
    log: (...values) => logs.push(values),
    error: (...values) => errors.push(values)
  }
}

function makeRuntime(amount = 0) {
  const remoteWallet = {
    isAuthenticated: vi.fn().mockResolvedValue({ authenticated: true }),
    internalizeAction: vi.fn().mockResolvedValue({ accepted: true })
  } as unknown as WalletInterface
  const localWallet = {
    isAuthenticated: vi.fn().mockResolvedValue({ authenticated: true }),
    getVersion: vi.fn().mockResolvedValue({ version: '1.2.3' }),
    getPublicKey: vi
      .fn()
      .mockResolvedValueOnce({ publicKey: 'payer' })
      .mockResolvedValueOnce({ publicKey: 'derived' }),
    createAction: vi.fn().mockResolvedValue({ tx: [1, 2, 3], txid: 'abc123' })
  } as unknown as WalletInterface
  const dependencies: FundingDependencies = {
    createDestinationWallet: vi.fn().mockResolvedValue({
      wallet: remoteWallet,
      balance: 42
    }),
    createLocalWallet: vi.fn(() => localWallet),
    randomBase64: vi
      .fn()
      .mockReturnValueOnce('derivation-prefix')
      .mockReturnValueOnce('derivation-suffix'),
    privateKeyToPublicKey: vi.fn(() => 'payee'),
    lockingScriptForPublicKey: vi.fn(() => 'locking-script')
  }
  return {
    options: {
      chain: 'main' as const,
      storageURL: DEFAULT_STORAGE_URL,
      privateKey: VALID_PRIVATE_KEY,
      amount
    },
    remoteWallet,
    localWallet,
    dependencies
  }
}

describe('parseCliArguments', () => {
  it('recognizes help and interactive modes', () => {
    expect(parseCliArguments(['--help'])).toEqual({ kind: 'help' })
    expect(parseCliArguments(['-h'])).toEqual({ kind: 'help' })
    expect(parseCliArguments([])).toEqual({ kind: 'interactive' })
  })

  it('requires a chain and private key', () => {
    expect(parseCliArguments(['--private-key', VALID_PRIVATE_KEY])).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('--chain')
    })
    expect(parseCliArguments(['--chain', 'main'])).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('--private-key')
    })
  })

  it('rejects invalid chains, keys, URLs, credentials, and amounts', () => {
    const base = ['--chain', 'main', '--private-key', VALID_PRIVATE_KEY]
    expect(parseCliArguments(['--chain', 'stn', '--private-key', VALID_PRIVATE_KEY])).toMatchObject(
      {
        kind: 'error',
        message: expect.stringContaining('Invalid network')
      }
    )
    expect(parseCliArguments(['--chain', 'main', '--private-key', 'bad'])).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('Invalid private key')
    })
    expect(parseCliArguments(['--chain', 'main', '--private-key', '0'.repeat(64)])).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('Invalid private key')
    })
    expect(
      parseCliArguments([
        '--chain',
        'main',
        '--private-key',
        'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
      ])
    ).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('Invalid private key')
    })
    for (const url of [
      'http://store.example.com',
      'not-a-url',
      'https://user:pass@store.example.com'
    ]) {
      expect(parseCliArguments([...base, '--storage-url', url])).toMatchObject({
        kind: 'error',
        message: expect.stringContaining('Invalid storage URL')
      })
    }
    for (const amount of ['-1', '1.5', 'Infinity', '9007199254740992']) {
      expect(parseCliArguments([...base, '--satoshis', amount])).toMatchObject({
        kind: 'error',
        message: expect.stringContaining('Invalid satoshis')
      })
    }
  })

  it('accepts documented aliases and defaults', () => {
    expect(
      parseCliArguments([
        '--network',
        'test',
        '--privateKey',
        VALID_PRIVATE_KEY,
        '--storageURL',
        'https://storage.example.com',
        '--satoshis',
        '1000'
      ])
    ).toEqual({
      kind: 'run',
      options: {
        chain: 'test',
        storageURL: 'https://storage.example.com',
        privateKey: VALID_PRIVATE_KEY,
        amount: 1000
      }
    })
    expect(
      parseCliArguments(['--chain', 'main', '--private-key', VALID_PRIVATE_KEY])
    ).toMatchObject({
      kind: 'run',
      options: { storageURL: DEFAULT_STORAGE_URL, amount: 0 }
    })
  })
})

describe('default funding adapters', () => {
  it('constructs a destination wallet and reads its basket balance', async () => {
    const makeAvailable = vi
      .spyOn(StorageClient.prototype, 'makeAvailable')
      .mockResolvedValue({} as never)
    const addProvider = vi
      .spyOn(WalletStorageManager.prototype, 'addWalletStorageProvider')
      .mockResolvedValue(undefined)
    const listOutputs = vi
      .spyOn(Wallet.prototype, 'listOutputs')
      .mockResolvedValue({ totalOutputs: 7, outputs: [] })

    const destination = await createDestinationWallet(
      'main',
      DEFAULT_STORAGE_URL,
      VALID_PRIVATE_KEY
    )
    expect(destination.balance).toBe(7)
    expect(makeAvailable).toHaveBeenCalledOnce()
    expect(addProvider).toHaveBeenCalledOnce()
    expect(listOutputs).toHaveBeenCalledWith(
      {
        basket: '893b7646de0e1c9f741bd6e9169b76a8847ae34adef7bef1e6a285371206d2e8'
      },
      'admin.com'
    )
  })

  it('provides real local-wallet, randomness, key, and script adapters', () => {
    expect(defaultFundingDependencies.createLocalWallet()).toBeDefined()
    expect(defaultFundingDependencies.randomBase64(10)).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
    const publicKey = defaultFundingDependencies.privateKeyToPublicKey(VALID_PRIVATE_KEY)
    expect(publicKey).toHaveLength(66)
    expect(defaultFundingDependencies.lockingScriptForPublicKey(publicKey)).toMatch(
      /^76a914[0-9a-f]{40}88ac$/
    )
  })
})

describe('fundWallet', () => {
  it('reports the destination balance without requiring a local wallet when amount is zero', async () => {
    const runtime = makeRuntime()
    const io = makeIO()
    await fundWallet(runtime.options, runtime.dependencies, io)
    expect(runtime.dependencies.createDestinationWallet).toHaveBeenCalledWith(
      'main',
      DEFAULT_STORAGE_URL,
      VALID_PRIVATE_KEY
    )
    expect(runtime.dependencies.createLocalWallet).not.toHaveBeenCalled()
    expect(io.logs.flat().join(' ')).toContain('42')
  })

  it('constructs and internalizes a deterministic wallet payment', async () => {
    const runtime = makeRuntime(500)
    const io = makeIO()
    await fundWallet(runtime.options, runtime.dependencies, io)

    expect(runtime.localWallet.getPublicKey).toHaveBeenNthCalledWith(1, {
      identityKey: true
    })
    expect(runtime.localWallet.getPublicKey).toHaveBeenNthCalledWith(2, {
      counterparty: 'payee',
      protocolID: [2, '3241645161d8'],
      keyID: 'derivation-prefix derivation-suffix'
    })
    expect(runtime.localWallet.createAction).toHaveBeenCalledWith(
      expect.objectContaining({
        outputs: [
          expect.objectContaining({
            lockingScript: 'locking-script',
            satoshis: 500
          })
        ],
        options: { randomizeOutputs: false }
      })
    )
    expect(runtime.remoteWallet.internalizeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        tx: [1, 2, 3],
        outputs: [
          expect.objectContaining({
            outputIndex: 0,
            paymentRemittance: {
              derivationPrefix: 'derivation-prefix',
              derivationSuffix: 'derivation-suffix',
              senderIdentityKey: 'payer'
            }
          })
        ]
      })
    )
    expect(io.logs.flat().join(' ')).toContain('abc123')
  })

  it('fails safely when the local wallet is unavailable or returns no transaction', async () => {
    const unavailable = makeRuntime(1)
    vi.mocked(unavailable.localWallet.getVersion).mockRejectedValueOnce(new Error('offline'))
    await expect(
      fundWallet(unavailable.options, unavailable.dependencies, makeIO())
    ).rejects.toThrow('Metanet Desktop is not installed or not running')

    const incomplete = makeRuntime(1)
    vi.mocked(incomplete.localWallet.createAction).mockResolvedValueOnce({})
    await expect(fundWallet(incomplete.options, incomplete.dependencies, makeIO())).rejects.toThrow(
      'did not return a complete funding transaction'
    )
  })
})

describe('runCli', () => {
  it('prints help without touching either wallet', async () => {
    const runtime = makeRuntime()
    const io = makeIO()
    expect(await runCli(['--help'], runtime.dependencies, io)).toBe(0)
    expect(runtime.dependencies.createDestinationWallet).not.toHaveBeenCalled()
    expect(io.logs.flat().join('\n')).toContain('fund-metanet')
  })

  it('runs validated CLI arguments and reports funding failures', async () => {
    const success = makeRuntime()
    expect(
      await runCli(
        ['--chain', 'main', '--private-key', VALID_PRIVATE_KEY],
        success.dependencies,
        makeIO()
      )
    ).toBe(0)
    expect(success.dependencies.createDestinationWallet).toHaveBeenCalledOnce()

    const failed = makeRuntime()
    vi.mocked(failed.dependencies.createDestinationWallet).mockRejectedValueOnce(
      new Error('storage unavailable')
    )
    const io = makeIO()
    expect(
      await runCli(['--chain', 'main', '--private-key', VALID_PRIVATE_KEY], failed.dependencies, io)
    ).toBe(1)
    expect(io.errors.flat().join(' ')).toContain('storage unavailable')
  })

  it('collects interactive defaults, closes the prompt, and validates input', async () => {
    const runtime = makeRuntime()
    const prompt: PromptSession = {
      ask: vi
        .fn()
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce(VALID_PRIVATE_KEY)
        .mockResolvedValueOnce(''),
      close: vi.fn()
    }
    expect(await runCli([], runtime.dependencies, makeIO(), () => prompt)).toBe(0)
    expect(runtime.dependencies.createDestinationWallet).toHaveBeenCalledWith(
      'main',
      DEFAULT_STORAGE_URL,
      VALID_PRIVATE_KEY
    )
    expect(prompt.close).toHaveBeenCalledOnce()

    const invalidPrompt: PromptSession = {
      ask: vi
        .fn()
        .mockResolvedValueOnce('main')
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce(''),
      close: vi.fn()
    }
    expect(await runCli([], runtime.dependencies, makeIO(), () => invalidPrompt)).toBe(1)
    expect(invalidPrompt.close).toHaveBeenCalledOnce()
  })
})
