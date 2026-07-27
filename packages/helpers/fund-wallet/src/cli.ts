import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import chalk from 'chalk'
import type { InternalizeActionArgs, WalletInterface } from '@bsv/sdk' with {
  'resolution-mode': 'require'
}
import {
  Services,
  StorageClient,
  Wallet,
  WalletSigner,
  WalletStorageManager
} from '@bsv/wallet-toolbox'

type CommonJsSdk = typeof import('@bsv/sdk', {
  with: { 'resolution-mode': 'require' }
})

// Wallet Toolbox is currently a CommonJS package. Load the matching SDK
// condition so both packages share one runtime module and one nominal type
// identity; importing the SDK's ESM condition here would create a dual-package
// hazard for private-field classes such as PrivateKey and BigNumber.
const { KeyDeriver, P2PKH, PrivateKey, PublicKey, WalletClient } = createRequire(import.meta.url)(
  '@bsv/sdk'
) as CommonJsSdk

export type Chain = 'test' | 'main'

export interface FundingOptions {
  chain: Chain
  storageURL: string
  privateKey: string
  amount: number
}

interface DestinationWallet {
  wallet: WalletInterface
  balance: number
}

export interface FundingDependencies {
  createDestinationWallet(
    chain: Chain,
    storageURL: string,
    privateKey: string
  ): Promise<DestinationWallet>
  createLocalWallet(): WalletInterface
  randomBase64(size: number): string
  privateKeyToPublicKey(privateKey: string): string
  lockingScriptForPublicKey(publicKey: string): string
}

export interface CliIO {
  log(...values: unknown[]): void
  error(...values: unknown[]): void
}

export interface PromptSession {
  ask(question: string): Promise<string>
  close(): void
}

export type CliParseResult =
  | { kind: 'help' }
  | { kind: 'interactive' }
  | { kind: 'run'; options: FundingOptions }
  | { kind: 'error'; message: string }

export const DEFAULT_STORAGE_URL = 'https://store-us-1.bsvb.tech'

export async function createDestinationWallet(
  chain: Chain,
  storageURL: string,
  privateKey: string
): Promise<DestinationWallet> {
  const keyDeriver = new KeyDeriver(new PrivateKey(privateKey, 'hex', 'be', 'error'))
  const storageManager = new WalletStorageManager(keyDeriver.identityKey)
  const signer = new WalletSigner(chain, keyDeriver, storageManager)
  const wallet = new Wallet(signer, new Services(chain))
  const client = new StorageClient(wallet, storageURL)
  await client.makeAvailable()
  await storageManager.addWalletStorageProvider(client)

  const { totalOutputs } = await wallet.listOutputs(
    { basket: '893b7646de0e1c9f741bd6e9169b76a8847ae34adef7bef1e6a285371206d2e8' },
    'admin.com'
  )
  return { wallet, balance: totalOutputs }
}

export const defaultFundingDependencies: FundingDependencies = {
  createDestinationWallet,
  createLocalWallet: () => new WalletClient('secure-json-api', 'deggen.com'),
  randomBase64: size => randomBytes(size).toString('base64'),
  privateKeyToPublicKey: privateKey =>
    new PrivateKey(privateKey, 'hex', 'be', 'error').toPublicKey().toString(),
  lockingScriptForPublicKey: publicKey =>
    new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex()
}

const consoleIO: CliIO = {
  log: (...values) => console.log(...values),
  error: (...values) => console.error(...values)
}

export async function fundWallet(
  options: FundingOptions,
  dependencies: FundingDependencies = defaultFundingDependencies,
  io: CliIO = consoleIO
): Promise<void> {
  const { wallet, balance } = await dependencies.createDestinationWallet(
    options.chain,
    options.storageURL,
    options.privateKey
  )
  io.log(chalk.green(`💰 Wallet balance: ${balance}`))
  if (options.amount === 0) return

  const remote = await wallet.isAuthenticated({})
  io.log({ remote })

  const localWallet = dependencies.createLocalWallet()
  const local = await localWallet.isAuthenticated({})
  io.log({ local })
  try {
    const { version } = await localWallet.getVersion({})
    io.log(chalk.blue(`💰 Using local wallet version: ${version}`))
  } catch {
    throw new Error(
      'Metanet Desktop is not installed or not running. ' +
        'Download it from https://metanet.bsvb.tech'
    )
  }

  const derivationPrefix = dependencies.randomBase64(10)
  const derivationSuffix = dependencies.randomBase64(10)
  const { publicKey: payer } = await localWallet.getPublicKey({ identityKey: true })
  const payee = dependencies.privateKeyToPublicKey(options.privateKey)
  const { publicKey: derivedPublicKey } = await localWallet.getPublicKey({
    counterparty: payee,
    protocolID: [2, '3241645161d8'],
    keyID: `${derivationPrefix} ${derivationSuffix}`
  })
  const lockingScript = dependencies.lockingScriptForPublicKey(derivedPublicKey)
  const transaction = await localWallet.createAction({
    outputs: [
      {
        lockingScript,
        customInstructions: JSON.stringify({
          derivationPrefix,
          derivationSuffix,
          payee
        }),
        satoshis: options.amount,
        outputDescription: 'Fund wallet for remote use'
      }
    ],
    description: 'Funding wallet for remote use',
    options: {
      randomizeOutputs: false
    }
  })
  if (!transaction.tx || !transaction.txid) {
    throw new Error('The local wallet did not return a complete funding transaction')
  }

  const directTransaction: InternalizeActionArgs = {
    tx: transaction.tx,
    outputs: [
      {
        outputIndex: 0,
        protocol: 'wallet payment',
        paymentRemittance: {
          derivationPrefix,
          derivationSuffix,
          senderIdentityKey: payer
        }
      }
    ],
    description: 'Incoming wallet funding payment from local wallet'
  }
  const result = await wallet.internalizeAction(directTransaction)
  io.log(chalk.green(`🎉 Wallet funded! ${JSON.stringify(result)}`))
  io.log(chalk.blue(`🔗 View on WhatsOnChain: https://whatsonchain.com/tx/${transaction.txid}`))
}

function argumentValue(arguments_: string[], name: string): string | undefined {
  const index = arguments_.indexOf(`--${name}`)
  return index !== -1 && index + 1 < arguments_.length ? arguments_[index + 1] : undefined
}

function validStorageURL(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === ''
  } catch {
    return false
  }
}

function validateOptions(
  chain: string,
  storageURL: string,
  privateKey: string,
  satoshis?: string
): CliParseResult {
  if (chain !== 'test' && chain !== 'main') {
    return { kind: 'error', message: `Invalid network: ${chain}. Must be "test" or "main"` }
  }
  if (!validStorageURL(storageURL)) {
    return {
      kind: 'error',
      message: `Invalid storage URL: ${storageURL}. Must be a credential-free HTTPS URL`
    }
  }
  if (!/^[0-9a-fA-F]{64}$/.test(privateKey) || /^0{64}$/.test(privateKey)) {
    return { kind: 'error', message: 'Invalid private key: Must be 32-byte hex format' }
  }
  try {
    new PrivateKey(privateKey, 'hex', 'be', 'error')
  } catch {
    return { kind: 'error', message: 'Invalid private key: Must be valid secp256k1 key material' }
  }

  const amount = satoshis === undefined || satoshis === '' ? 0 : Number(satoshis)
  if (!Number.isSafeInteger(amount) || amount < 0) {
    return {
      kind: 'error',
      message: `Invalid satoshis: ${satoshis}. Must be a non-negative safe integer`
    }
  }
  return {
    kind: 'run',
    options: { chain, storageURL, privateKey, amount }
  }
}

export function parseCliArguments(arguments_: string[]): CliParseResult {
  if (arguments_.includes('--help') || arguments_.includes('-h')) return { kind: 'help' }
  if (arguments_.length === 0) return { kind: 'interactive' }

  const chain = argumentValue(arguments_, 'chain') ?? argumentValue(arguments_, 'network')
  if (!chain) return { kind: 'error', message: 'Missing required argument: --chain' }

  const privateKey =
    argumentValue(arguments_, 'private-key') ?? argumentValue(arguments_, 'privateKey')
  if (!privateKey) {
    return { kind: 'error', message: 'Missing required argument: --private-key' }
  }

  const storageURL =
    argumentValue(arguments_, 'storage-url') ??
    argumentValue(arguments_, 'storageURL') ??
    DEFAULT_STORAGE_URL
  return validateOptions(chain, storageURL, privateKey, argumentValue(arguments_, 'satoshis'))
}

function printHelp(io: CliIO, errorMessage?: string): void {
  if (errorMessage) io.error(chalk.red(`\n❌ ${errorMessage}\n`))
  io.log(String.raw`${chalk.bold('fund-metanet')} - Fund a Metanet wallet

${chalk.bold('USAGE:')}
  fund-metanet [OPTIONS]

${chalk.bold('OPTIONS:')}
  --chain <network>           Network to use: "test" or "main" (required)
  --private-key <hex>         Wallet private key in hex format (required)
  --storage-url <url>         Credential-free HTTPS storage provider URL
                              (default: ${DEFAULT_STORAGE_URL})
  --satoshis <amount>         Non-negative integer amount to fund
                              (omit or use 0 to check balance only)
  --help                      Show this help message

${chalk.bold('EXAMPLES:')}
  fund-metanet --chain main --private-key <hex> --satoshis 1000
  fund-metanet --chain main --private-key <hex>
  fund-metanet --chain test --private-key <hex> \
    --storage-url ${DEFAULT_STORAGE_URL} --satoshis 500
`)
}

function createPromptSession(): PromptSession {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout
  })
  return {
    ask: question => new Promise(resolve => readline.question(question, resolve)),
    close: () => readline.close()
  }
}

async function interactiveOptions(prompt: PromptSession): Promise<CliParseResult> {
  const chain = (await prompt.ask('Enter network (test or main), default main: ')) || 'main'
  const storageURL =
    (await prompt.ask(`Enter Wallet Storage URL, default ${DEFAULT_STORAGE_URL}: `)) ||
    DEFAULT_STORAGE_URL
  const privateKey = await prompt.ask('Enter wallet private key: ')
  if (!privateKey) return { kind: 'error', message: 'Missing required input: private key' }
  const satoshis = await prompt.ask('Enter amount in satoshis or leave blank for balance: ')
  return validateOptions(chain, storageURL, privateKey, satoshis)
}

export async function runCli(
  arguments_: string[],
  dependencies: FundingDependencies = defaultFundingDependencies,
  io: CliIO = consoleIO,
  promptFactory: () => PromptSession = createPromptSession
): Promise<number> {
  let parsed = parseCliArguments(arguments_)
  if (parsed.kind === 'help') {
    printHelp(io)
    return 0
  }
  if (parsed.kind === 'interactive') {
    const prompt = promptFactory()
    try {
      parsed = await interactiveOptions(prompt)
    } finally {
      prompt.close()
    }
  }
  if (parsed.kind === 'error') {
    printHelp(io, parsed.message)
    return 1
  }
  const ready = parsed as Extract<CliParseResult, { kind: 'run' }>

  try {
    await fundWallet(ready.options, dependencies, io)
    return 0
  } catch (error) {
    io.error(chalk.red(`❌ ${error instanceof Error ? error.message : String(error)}`))
    return 1
  }
}
