import type { WalletInterface } from '@bsv/sdk'
import { StorageClient, Wallet, WalletStorageManager } from '@bsv/wallet-toolbox'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  createPromptSession,
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

function makeSecretPrompt(privateKey = VALID_PRIVATE_KEY): PromptSession {
  return {
    ask: vi.fn(),
    askSecret: vi.fn().mockResolvedValue(privateKey),
    close: vi.fn()
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

  it('requires a chain and rejects private keys in process arguments', () => {
    expect(parseCliArguments(['--private-key', VALID_PRIVATE_KEY])).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('--chain')
    })
    expect(
      parseCliArguments(['--chain', 'main', '--private-key', VALID_PRIVATE_KEY])
    ).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('not accepted in command-line arguments')
    })
    expect(
      parseCliArguments(['--chain', 'main', `--private-key=${VALID_PRIVATE_KEY}`])
    ).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('not accepted in command-line arguments')
    })
    expect(parseCliArguments(['--chain', 'main', '--privateKey', VALID_PRIVATE_KEY])).toMatchObject(
      {
        kind: 'error',
        message: expect.stringContaining('not accepted in command-line arguments')
      }
    )
    expect(
      parseCliArguments(['--chain', 'main', `--privateKey=${VALID_PRIVATE_KEY}`])
    ).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('not accepted in command-line arguments')
    })
    expect(parseCliArguments(['--chain'])).toEqual({
      kind: 'error',
      message: 'Missing required argument: --chain'
    })
  })

  it('rejects invalid chains, URLs, credentials, and amounts', () => {
    const base = ['--chain', 'main']
    expect(parseCliArguments(['--chain', 'stn'])).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('Invalid network')
    })
    for (const url of [
      'http://store.example.com',
      'not-a-url',
      'https://user:pass@store.example.com',
      'https://user@store.example.com',
      'https://:pass@store.example.com'
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
        '--storageURL',
        'https://storage.example.com',
        '--satoshis',
        '1000'
      ])
    ).toEqual({
      kind: 'prompt-key',
      options: {
        chain: 'test',
        storageURL: 'https://storage.example.com',
        amount: 1000
      }
    })
    expect(parseCliArguments(['--chain', 'main'])).toMatchObject({
      kind: 'prompt-key',
      options: { storageURL: DEFAULT_STORAGE_URL, amount: 0 }
    })
    expect(parseCliArguments(['--chain', 'test', '--satoshis', ''])).toEqual({
      kind: 'prompt-key',
      options: { chain: 'test', storageURL: DEFAULT_STORAGE_URL, amount: 0 }
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
    expect(io.logs.flat().join(' ')).toContain('Wallet funded! {"accepted":true}')
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
    const successPrompt = makeSecretPrompt()
    expect(
      await runCli(['--chain', 'main'], success.dependencies, makeIO(), () => successPrompt)
    ).toBe(0)
    expect(success.dependencies.createDestinationWallet).toHaveBeenCalledOnce()
    expect(successPrompt.askSecret).toHaveBeenCalledOnce()

    const failed = makeRuntime()
    vi.mocked(failed.dependencies.createDestinationWallet).mockRejectedValueOnce(
      new Error('storage unavailable')
    )
    const io = makeIO()
    const failedPrompt = makeSecretPrompt()
    expect(await runCli(['--chain', 'main'], failed.dependencies, io, () => failedPrompt)).toBe(1)
    expect(io.errors.flat().join(' ')).toContain('storage unavailable')
  })

  it('rejects invalid private keys obtained from the secure prompt', async () => {
    for (const privateKey of ['bad', 'g'.repeat(64), '0'.repeat(64), 'f'.repeat(64)]) {
      const runtime = makeRuntime()
      const io = makeIO()
      expect(
        await runCli(['--chain', 'main'], runtime.dependencies, io, () =>
          makeSecretPrompt(privateKey)
        )
      ).toBe(1)
      expect(io.errors.flat().join(' ')).toContain('Invalid private key')
      expect(runtime.dependencies.createDestinationWallet).not.toHaveBeenCalled()
    }
  })

  it('reports cancellation while prompting for a private key', async () => {
    const runtime = makeRuntime()
    const io = makeIO()
    const prompt = makeSecretPrompt()
    vi.mocked(prompt.askSecret).mockRejectedValueOnce('input closed')

    expect(await runCli(['--chain', 'main'], runtime.dependencies, io, () => prompt)).toBe(1)
    expect(io.errors.flat().join(' ')).toContain('input closed')
    expect(prompt.close).toHaveBeenCalledOnce()
    expect(runtime.dependencies.createDestinationWallet).not.toHaveBeenCalled()
  })

  it('validates every interactive option before funding', async () => {
    const cases: Array<{ answers: string[]; secret: string; message: string }> = [
      {
        answers: ['stn', '', ''],
        secret: VALID_PRIVATE_KEY,
        message: 'Invalid network: stn. Must be "test" or "main"'
      },
      {
        answers: ['main', 'https://user@store.example.com', ''],
        secret: VALID_PRIVATE_KEY,
        message:
          'Invalid storage URL: https://user@store.example.com. Must be a credential-free HTTPS URL'
      },
      {
        answers: ['main', '', '-1'],
        secret: VALID_PRIVATE_KEY,
        message: 'Invalid satoshis: -1. Must be a non-negative safe integer'
      }
    ]

    for (const testCase of cases) {
      const runtime = makeRuntime()
      const io = makeIO()
      const prompt: PromptSession = {
        ask: vi
          .fn()
          .mockResolvedValueOnce(testCase.answers[0])
          .mockResolvedValueOnce(testCase.answers[1])
          .mockResolvedValueOnce(testCase.answers[2]),
        askSecret: vi.fn().mockResolvedValue(testCase.secret),
        close: vi.fn()
      }
      expect(await runCli([], runtime.dependencies, io, () => prompt)).toBe(1)
      expect(io.errors.flat().join(' ')).toContain(testCase.message)
      expect(runtime.dependencies.createDestinationWallet).not.toHaveBeenCalled()
      expect(prompt.close).toHaveBeenCalledOnce()
    }
  })

  it('collects interactive defaults, closes the prompt, and validates input', async () => {
    const runtime = makeRuntime()
    const prompt: PromptSession = {
      ask: vi.fn().mockResolvedValueOnce('').mockResolvedValueOnce('').mockResolvedValueOnce(''),
      askSecret: vi.fn().mockResolvedValue(VALID_PRIVATE_KEY),
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
      ask: vi.fn().mockResolvedValueOnce('main').mockResolvedValueOnce(''),
      askSecret: vi.fn().mockResolvedValue(''),
      close: vi.fn()
    }
    expect(await runCli([], runtime.dependencies, makeIO(), () => invalidPrompt)).toBe(1)
    expect(invalidPrompt.close).toHaveBeenCalledOnce()
  })
})

describe('createPromptSession', () => {
  function makeTerminal({ raw = false, paused = false } = {}) {
    const input = new PassThrough()
    const isPaused = vi.spyOn(input, 'isPaused').mockReturnValue(paused)
    const pause = vi.spyOn(input, 'pause')
    const resume = vi.spyOn(input, 'resume')
    const setRawMode = vi.fn()
    Object.assign(input, { isTTY: true, isRaw: raw, setRawMode })

    const output = new PassThrough()
    const write = vi.spyOn(output, 'write')
    const prompt = createPromptSession(
      input as unknown as typeof process.stdin,
      output as unknown as typeof process.stdout
    )
    return { input, output, write, isPaused, pause, resume, setRawMode, prompt }
  }

  it('collects printable input without echoing and restores terminal state', async () => {
    const { input, write, pause, resume, setRawMode, prompt } = makeTerminal()
    const secret = prompt.askSecret('Private key: ')

    input.emit('keypress', 'a', { name: 'a', ctrl: false, meta: false })
    input.emit('keypress', 'b', { name: 'b', ctrl: false, meta: false })
    input.emit('keypress', '', { name: 'backspace', ctrl: false, meta: false })
    input.emit('keypress', 'x', { name: 'x', ctrl: true, meta: false })
    input.emit('keypress', 'y', { name: 'y', ctrl: false, meta: true })
    input.emit('keypress', 'zz', { name: 'z', ctrl: false, meta: false })
    input.emit('keypress', '\u001f', { name: 'unknown', ctrl: false, meta: false })
    input.emit('keypress', '', { name: 'enter', ctrl: false, meta: false })

    await expect(secret).resolves.toBe('a')
    expect(setRawMode).toHaveBeenNthCalledWith(1, true)
    expect(setRawMode).toHaveBeenNthCalledWith(2, false)
    expect(resume).toHaveBeenCalled()
    expect(pause).not.toHaveBeenCalled()
    expect(write).toHaveBeenNthCalledWith(1, 'Private key: ')
    expect(write).toHaveBeenNthCalledWith(2, '\n')
  })

  it('reads one line when standard input is not a terminal', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const write = vi.spyOn(output, 'write')
    const prompt = createPromptSession(
      input as unknown as typeof process.stdin,
      output as unknown as typeof process.stdout
    )

    const secret = prompt.askSecret('Private key: ')
    input.write('from-pipe\n')

    await expect(secret).resolves.toBe('from-pipe')
    expect(write).toHaveBeenCalledWith('Private key: ')
  })

  it('cancels on control-c and restores a paused raw terminal', async () => {
    const { input, write, pause, setRawMode, prompt } = makeTerminal({ raw: true, paused: true })
    const secret = prompt.askSecret('Private key: ')

    input.emit('keypress', '\u0003', { name: 'c', ctrl: true, meta: false })

    await expect(secret).rejects.toThrow('Private key input cancelled')
    expect(setRawMode).toHaveBeenNthCalledWith(1, true)
    expect(setRawMode).toHaveBeenNthCalledWith(2, true)
    expect(pause).toHaveBeenCalledOnce()
    expect(write).toHaveBeenLastCalledWith('\n')
  })
})
