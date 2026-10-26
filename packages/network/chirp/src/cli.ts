#!/usr/bin/env node

import {
  constants as fsConstants,
  createReadStream,
  createWriteStream,
  promises as fs
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { CHIRPDownloader, type CHIRPDownloaderConfig } from './resolver.js'
import { CHIRPUploader, type CHIRPUploadCheckpoint, type CHIRPUploaderConfig } from './uploader.js'
import { hashHex } from './hash.js'
import type { CHIRPByteSource } from './types.js'
import { isPublicNetworkAddress } from '@bsv/sdk/storage/PublicHTTPSFetch'
import type { WalletInterface } from '@bsv/sdk/wallet/Wallet.interfaces'

export interface CHIRPCLIWriter {
  write(bytes: Uint8Array): boolean
  once(event: 'drain', listener: () => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
  end(listener: () => void): unknown
  destroy(): unknown
  commit?(): Promise<void>
  discard?(): Promise<void>
}

export interface CHIRPCLIRuntime {
  stat(path: string): Promise<{ size: number }>
  readFile(path: string, maximumBytes?: number): Promise<string>
  writeFile(path: string, data: string, options: { mode: number }): Promise<void>
  rm(path: string): Promise<void>
  createInput(path: string): CHIRPByteSource
  createOutput(path: string): CHIRPCLIWriter
  loadWallet(modulePath: string): Promise<WalletInterface>
  createUploader(config: CHIRPUploaderConfig): Pick<CHIRPUploader, 'publish'>
  createDownloader(config: CHIRPDownloaderConfig): Pick<CHIRPDownloader, 'stream' | 'inspect'>
  stdout(text: string): void
  stderr(text: string): void
}

const MAX_CHECKPOINT_BYTES = 1024 * 1024
const strictUTF8 = new TextDecoder('utf-8', { fatal: true })

export async function runCHIRPCLI(
  arguments_: string[],
  runtime: CHIRPCLIRuntime = DEFAULT_RUNTIME
): Promise<number> {
  const args = [...arguments_]
  const command = args.shift()
  if (command == null || command === '--help' || command === '-h') {
    help(runtime)
    return 0
  }
  try {
    if (command === 'publish') await publish(args, runtime)
    else if (command === 'retrieve') await retrieve(args, runtime)
    else if (command === 'verify') await verify(args, runtime)
    else throw new Error(`Unknown command: ${command}`)
    return 0
  } catch (error) {
    runtime.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function publish(argv: string[], runtime: CHIRPCLIRuntime): Promise<void> {
  const input = requiredPositional(argv, 'publish requires an input file.')
  const hosts = options(argv, '--host')
  const walletModule = option(argv, '--wallet-module')
  const retention = option(argv, '--retention-seconds')
  if (hosts.length === 0 || walletModule == null || retention == null) {
    throw new Error('publish requires --host, --wallet-module, and --retention-seconds.')
  }
  const stat = await runtime.stat(input)
  const wallet = await runtime.loadWallet(walletModule)
  const checkpointPath = option(argv, '--resume-file')
  const resume = checkpointPath == null ? undefined : await readCheckpoint(checkpointPath, runtime)
  const uploader = runtime.createUploader({
    wallet,
    storageURLs: hosts,
    resilienceLevel: Number(option(argv, '--resilience') ?? '1'),
    allowInsecureHTTP: flag(argv, '--allow-insecure-http'),
    allowPrivateHosts: flag(argv, '--allow-private-hosts')
  })
  const result = await uploader.publish({
    source: runtime.createInput(input),
    retentionSeconds: retention,
    logicalLength: stat.size,
    mediaType: option(argv, '--media-type'),
    resume,
    onCheckpoint:
      checkpointPath == null
        ? undefined
        : async checkpoint =>
            await runtime.writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`, {
              mode: 0o600
            })
  })
  runtime.stdout(
    `${JSON.stringify(
      {
        chirpURL: result.chirpURL,
        contentHash: hashHex(result.contentHash),
        logicalLength: result.logicalLength.toString(),
        objectCount: result.objectCount,
        hostedBy: result.hostedBy
      },
      null,
      2
    )}\n`
  )
}

async function retrieve(argv: string[], runtime: CHIRPCLIRuntime): Promise<void> {
  const chirpURL = requiredPositional(argv, 'retrieve requires a CHIRP URL.')
  const output = option(argv, '--output')
  if (output == null) throw new Error('retrieve requires --output.')
  const range = parseRange(option(argv, '--range'))
  const downloader = runtime.createDownloader({
    networkPreset: network(argv),
    concurrency: Number(option(argv, '--concurrency') ?? '4'),
    allowInsecureHTTP: flag(argv, '--allow-insecure-http'),
    allowPrivateHosts: flag(argv, '--allow-private-hosts')
  })
  const stream = runtime.createOutput(output)
  let streamError: Error | undefined
  const streamFailed = new Promise<void>(resolve => {
    stream.once('error', error => {
      streamError = error
      resolve()
    })
  })
  try {
    for await (const chunk of downloader.stream(chirpURL, { range })) {
      if (streamError != null) throw streamError
      if (!stream.write(chunk.data)) {
        await Promise.race([
          new Promise<void>(resolve => stream.once('drain', () => resolve())),
          streamFailed
        ])
        if (streamError != null) throw streamError
      }
    }
    if (streamError != null) throw streamError
    await Promise.race([new Promise<void>(resolve => stream.end(resolve)), streamFailed])
    if (streamError != null) throw streamError
    await stream.commit?.()
  } catch (error) {
    stream.destroy()
    if (stream.discard == null) await runtime.rm(output)
    else await stream.discard()
    throw error
  }
}

async function verify(argv: string[], runtime: CHIRPCLIRuntime): Promise<void> {
  const chirpURL = requiredPositional(argv, 'verify requires a CHIRP URL.')
  const downloader = runtime.createDownloader({
    networkPreset: network(argv),
    allowInsecureHTTP: flag(argv, '--allow-insecure-http'),
    allowPrivateHosts: flag(argv, '--allow-private-hosts')
  })
  let bytes = 0n
  for await (const chunk of downloader.stream(chirpURL)) bytes += BigInt(chunk.data.byteLength)
  const inspected = await downloader.inspect(chirpURL)
  runtime.stdout(
    `${JSON.stringify(
      {
        chirpURL,
        verified: true,
        logicalLength: bytes.toString(),
        contentHash: hashHex(inspected.root.contentHash)
      },
      null,
      2
    )}\n`
  )
}

export async function loadWallet(modulePath: string): Promise<WalletInterface> {
  const module = await import(pathToFileURL(modulePath).href)
  const candidate =
    typeof module.createWallet === 'function' ? await module.createWallet() : module.default
  if (candidate == null || typeof candidate !== 'object') {
    throw new Error('Wallet module must export default WalletInterface or createWallet().')
  }
  return candidate as WalletInterface
}

async function readCheckpoint(
  path: string,
  runtime: CHIRPCLIRuntime
): Promise<CHIRPUploadCheckpoint | undefined> {
  try {
    return JSON.parse(await runtime.readFile(path, MAX_CHECKPOINT_BYTES)) as CHIRPUploadCheckpoint
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export function parseRange(
  value: string | undefined
): { start: bigint; endExclusive: bigint } | undefined {
  if (value == null) return undefined
  const match = /^(0|[1-9]\d{0,19}):(0|[1-9]\d{0,19})$/.exec(value)
  if (match == null) throw new Error('--range must use start:endExclusive decimal syntax.')
  const start = BigInt(match[1])
  const endExclusive = BigInt(match[2])
  if (start > 0xffffffffffffffffn || endExclusive > 0xffffffffffffffffn) {
    throw new Error('--range boundaries must fit unsigned 64-bit integers.')
  }
  return { start, endExclusive }
}

export function network(argv: string[]): 'mainnet' | 'testnet' | 'teratestnet' {
  const value = option(argv, '--network') ?? 'mainnet'
  if (value !== 'mainnet' && value !== 'testnet' && value !== 'teratestnet') {
    throw new Error('--network must be mainnet, testnet, or teratestnet.')
  }
  return value
}

export function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (value == null || value.startsWith('--')) throw new Error(`${name} requires a value.`)
  argv.splice(index, 2)
  return value
}

export function options(argv: string[], name: string): string[] {
  const result: string[] = []
  while (argv.includes(name)) {
    const value = option(argv, name)
    if (value != null) result.push(value)
  }
  return result
}

export function requiredPositional(argv: string[], message: string): string {
  const value = argv.shift()
  if (value == null || value.startsWith('--')) throw new Error(message)
  return value
}

export function flag(argv: string[], name: string): boolean {
  const index = argv.indexOf(name)
  if (index === -1) return false
  argv.splice(index, 1)
  return true
}

export async function requirePublicHost(url: URL): Promise<void> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const addresses =
    isIP(hostname) === 0
      ? await lookup(hostname, { all: true, verbatim: true })
      : [{ address: hostname, family: isIP(hostname) }]
  if (
    addresses.length === 0 ||
    addresses.some(({ address, family }) =>
      family === 4 ? !isPublicIPv4(address) : !isPublicIPv6(address)
    )
  ) {
    throw new Error('CHIRP host DNS resolved to a non-public address.')
  }
}

export function allowAnyHost(): void {
  return undefined
}

export function isPublicIPv4(address: string): boolean {
  return isIP(address) === 4 && isPublicNetworkAddress(address)
}

export function isPublicIPv6(address: string): boolean {
  return isIP(address) === 6 && isPublicNetworkAddress(address)
}

function help(runtime: CHIRPCLIRuntime): void {
  runtime.stdout(`Usage:
  chirp publish <file> --host <url> [--host <url>] --wallet-module <path> --retention-seconds <seconds> [--resilience <n>] [--media-type <type>] [--resume-file <path>] [--allow-private-hosts] [--allow-insecure-http]
  chirp retrieve <chirp-url> --output <path> [--range <start:endExclusive>] [--network <preset>] [--concurrency <n>] [--allow-private-hosts] [--allow-insecure-http]
  chirp verify <chirp-url> [--network <preset>] [--allow-private-hosts] [--allow-insecure-http]
`)
}

const DEFAULT_RUNTIME: CHIRPCLIRuntime = {
  stat: async path => await fs.stat(path),
  readFile: async (path, maximumBytes = MAX_CHECKPOINT_BYTES) =>
    await readPrivateFileBounded(path, maximumBytes),
  writeFile: async (path, data, options) => await writePrivateFileAtomic(path, data, options.mode),
  rm: async path => await fs.rm(path, { force: true }),
  createInput: path => createReadStream(path),
  createOutput: createPrivateOutput,
  loadWallet,
  createUploader: config => new CHIRPUploader(config),
  createDownloader: config => new CHIRPDownloader(config),
  stdout: text => {
    process.stdout.write(text)
  },
  stderr: text => {
    process.stderr.write(text)
  }
}

export async function readPrivateFileBounded(path: string, maximumBytes: number): Promise<string> {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 0 ||
    maximumBytes > MAX_CHECKPOINT_BYTES
  ) {
    throw new RangeError(`maximumBytes must be from 0 through ${MAX_CHECKPOINT_BYTES}.`)
  }
  const handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const stats = await handle.stat()
    if (!stats.isFile() || stats.size > maximumBytes) {
      throw new Error('CHIRP resume file exceeds its byte limit or is not a regular file.')
    }
    const bytes = new Uint8Array(maximumBytes + 1)
    let length = 0
    while (length < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, length, bytes.byteLength - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > maximumBytes) throw new Error('CHIRP resume file exceeds its byte limit.')
    return strictUTF8.decode(bytes.subarray(0, length))
  } finally {
    await handle.close()
  }
}

export async function writePrivateFileAtomic(
  path: string,
  data: string,
  mode: number
): Promise<void> {
  const directory = dirname(path)
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      mode
    )
    await handle.writeFile(data, { encoding: 'utf8' })
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(temporary, path)
  } finally {
    await handle?.close().catch(() => {})
    await fs.rm(temporary, { force: true }).catch(() => {})
  }
}

export function createPrivateOutput(path: string): CHIRPCLIWriter {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.download`
  )
  const stream = createWriteStream(temporary, { flags: 'wx', mode: 0o600 }) as CHIRPCLIWriter
  stream.commit = async () => {
    await fs.link(temporary, path)
    await fs.rm(temporary, { force: true }).catch(() => {})
  }
  stream.discard = async () => {
    await fs.rm(temporary, { force: true })
  }
  return stream
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await runCHIRPCLI(process.argv.slice(2))
}
