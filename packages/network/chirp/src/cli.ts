#!/usr/bin/env node

import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { CHIRPDownloader, type CHIRPDownloaderConfig } from './resolver.js'
import { CHIRPUploader, type CHIRPUploadCheckpoint, type CHIRPUploaderConfig } from './uploader.js'
import { hashHex } from './hash.js'
import type { CHIRPByteSource } from './types.js'
import type { WalletInterface } from '@bsv/sdk'

interface CHIRPCLIWriter {
  write(bytes: Uint8Array): boolean
  once(event: 'drain', listener: () => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
  end(listener: () => void): unknown
  destroy(): unknown
}

export interface CHIRPCLIRuntime {
  stat(path: string): Promise<{ size: number }>
  readFile(path: string): Promise<string>
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
    allowInsecureHTTP: flag(argv, '--allow-insecure-http')
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
    urlPolicy: flag(argv, '--allow-private-hosts') ? allowAnyHost : requirePublicHost
  })
  const stream = runtime.createOutput(output)
  try {
    for await (const chunk of downloader.stream(chirpURL, { range })) {
      if (!stream.write(chunk.data)) {
        await new Promise<void>(resolve => stream.once('drain', () => resolve()))
      }
    }
    await new Promise<void>((resolve, reject) => {
      stream.once('error', reject)
      stream.end(resolve)
    })
  } catch (error) {
    stream.destroy()
    await runtime.rm(output)
    throw error
  }
}

async function verify(argv: string[], runtime: CHIRPCLIRuntime): Promise<void> {
  const chirpURL = requiredPositional(argv, 'verify requires a CHIRP URL.')
  const downloader = runtime.createDownloader({
    networkPreset: network(argv),
    allowInsecureHTTP: flag(argv, '--allow-insecure-http'),
    urlPolicy: flag(argv, '--allow-private-hosts') ? allowAnyHost : requirePublicHost
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
    return JSON.parse(await runtime.readFile(path)) as CHIRPUploadCheckpoint
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export function parseRange(
  value: string | undefined
): { start: bigint; endExclusive: bigint } | undefined {
  if (value == null) return undefined
  const match = /^(0|[1-9]\d*):(0|[1-9]\d*)$/.exec(value)
  if (match == null) throw new Error('--range must use start:endExclusive decimal syntax.')
  return { start: BigInt(match[1]), endExclusive: BigInt(match[2]) }
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

export function allowAnyHost(): void {}

export function isPublicIPv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255))
    return false
  const [a, b, c] = parts
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  )
}

export function isPublicIPv6(address: string): boolean {
  const normalized = address.toLowerCase()
  return /^[23][0-9a-f]{3}:/.test(normalized) && !normalized.startsWith('2001:db8:')
}

function help(runtime: CHIRPCLIRuntime): void {
  runtime.stdout(`Usage:
  chirp publish <file> --host <url> [--host <url>] --wallet-module <path> --retention-seconds <seconds> [--resilience <n>] [--media-type <type>] [--resume-file <path>] [--allow-insecure-http]
  chirp retrieve <chirp-url> --output <path> [--range <start:endExclusive>] [--network <preset>] [--concurrency <n>] [--allow-private-hosts] [--allow-insecure-http]
  chirp verify <chirp-url> [--network <preset>] [--allow-private-hosts] [--allow-insecure-http]
`)
}

const DEFAULT_RUNTIME: CHIRPCLIRuntime = {
  stat: async path => await fs.stat(path),
  readFile: async path => await fs.readFile(path, 'utf8'),
  writeFile: async (path, data, options) => await fs.writeFile(path, data, options),
  rm: async path => await fs.rm(path, { force: true }),
  createInput: path => createReadStream(path),
  createOutput: path => createWriteStream(path, { flags: 'wx' }),
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await runCHIRPCLI(process.argv.slice(2))
}
