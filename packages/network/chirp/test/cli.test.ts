import { fileURLToPath } from 'node:url'
import { describe, expect, test } from '@jest/globals'
import {
  allowAnyHost,
  flag,
  isPublicIPv4,
  isPublicIPv6,
  loadWallet,
  network,
  option,
  options,
  parseRange,
  requirePublicHost,
  requiredPositional,
  runCHIRPCLI
} from '../src/cli.js'
import type { CHIRPCLIRuntime } from '../src/cli.js'
import type { CHIRPUploadCheckpoint } from '../src/uploader.js'

const IDENTIFIER = 'XUSvYkywHxEMvs7oiYYMV8bJ1sJjHq2mHgZvu8jSLyLhbNRVjG8E'
const CHECKPOINT: CHIRPUploadCheckpoint = {
  version: 1,
  retentionSeconds: '60',
  logicalLength: '3',
  sessions: []
}

interface RuntimeEvidence {
  stdout: string[]
  stderr: string[]
  writes: Array<{ path: string; data: string; mode: number }>
  removed: string[]
  destroyed: boolean
  uploaderConfig?: unknown
  downloaderConfig?: unknown
  publishOptions?: unknown
  streamOptions?: unknown
}

function fakeRuntime(overrides: Partial<CHIRPCLIRuntime> = {}): {
  runtime: CHIRPCLIRuntime
  evidence: RuntimeEvidence
} {
  const evidence: RuntimeEvidence = {
    stdout: [],
    stderr: [],
    writes: [],
    removed: [],
    destroyed: false
  }
  const runtime = {
    stat: async () => ({ size: 3 }),
    readFile: async () => {
      const error = new Error('missing') as NodeJS.ErrnoException
      error.code = 'ENOENT'
      throw error
    },
    writeFile: async (path: string, data: string, settings: { mode: number }) => {
      evidence.writes.push({ path, data, mode: settings.mode })
    },
    rm: async (path: string) => {
      evidence.removed.push(path)
    },
    createInput: () => Uint8Array.of(1, 2, 3),
    createOutput: () => ({
      write: () => false,
      once(event: string, listener: (...arguments_: unknown[]) => void) {
        if (event === 'drain') listener()
        return this
      },
      end(listener: () => void) {
        listener()
        return this
      },
      destroy() {
        evidence.destroyed = true
      }
    }),
    loadWallet: async () => ({}),
    createUploader: (config: unknown) => {
      evidence.uploaderConfig = config
      return {
        publish: async (publishOptions: {
          onCheckpoint?: (checkpoint: CHIRPUploadCheckpoint) => void | Promise<void>
        }) => {
          evidence.publishOptions = publishOptions
          await publishOptions.onCheckpoint?.(CHECKPOINT)
          return {
            chirpURL: `chirp://${IDENTIFIER}`,
            rootIdentifier: IDENTIFIER,
            rootBytes: new Uint8Array(),
            root: {
              majorVersion: 1,
              minorVersion: 0,
              nodeKind: 0,
              chunkingProfile: 1,
              logicalLength: 3n,
              contentHash: new Uint8Array(32),
              children: [],
              extensions: []
            },
            contentHash: new Uint8Array(32),
            logicalLength: 3n,
            objectCount: 2,
            hostedBy: ['https://host.example'],
            commits: [],
            checkpoint: CHECKPOINT
          }
        }
      }
    },
    createDownloader: (config: unknown) => {
      evidence.downloaderConfig = config
      return {
        stream: (_chirpURL: string, streamOptions?: unknown) => {
          evidence.streamOptions = streamOptions
          return (async function* () {
            yield { data: Uint8Array.of(1, 2), logicalOffset: 0n, objectIdentifier: IDENTIFIER }
          })()
        },
        inspect: async () => ({ root: { contentHash: new Uint8Array(32) } })
      }
    },
    stdout: (text: string) => evidence.stdout.push(text),
    stderr: (text: string) => evidence.stderr.push(text),
    ...overrides
  } as unknown as CHIRPCLIRuntime
  return { runtime, evidence }
}

describe('CLI option parsing and network policy', () => {
  test('parses ranges, networks, scalar/repeated options, positionals, and flags', () => {
    expect(parseRange(undefined)).toBeUndefined()
    expect(parseRange('0:12')).toEqual({ start: 0n, endExclusive: 12n })
    for (const value of ['01:2', '1:02', 'bad']) expect(() => parseRange(value)).toThrow('--range')

    expect(network([])).toBe('mainnet')
    for (const preset of ['mainnet', 'testnet', 'teratestnet'] as const) {
      expect(network(['--network', preset])).toBe(preset)
    }
    expect(() => network(['--network', 'invalid'])).toThrow('--network')

    const scalar = ['--name', 'value', 'tail']
    expect(option(scalar, '--absent')).toBeUndefined()
    expect(option(scalar, '--name')).toBe('value')
    expect(scalar).toEqual(['tail'])
    expect(() => option(['--name'], '--name')).toThrow('requires a value')
    expect(() => option(['--name', '--next'], '--name')).toThrow('requires a value')
    const repeated = ['--host', 'a', '--host', 'b']
    expect(options(repeated, '--host')).toEqual(['a', 'b'])
    expect(repeated).toEqual([])

    const positional = ['file']
    expect(requiredPositional(positional, 'required')).toBe('file')
    expect(() => requiredPositional([], 'required')).toThrow('required')
    expect(() => requiredPositional(['--flag'], 'required')).toThrow('required')
    const flags = ['--enabled']
    expect(flag(flags, '--missing')).toBe(false)
    expect(flag(flags, '--enabled')).toBe(true)
    expect(flags).toEqual([])
  })

  test('classifies public IPv4 and IPv6 destinations at reserved boundaries', async () => {
    for (const address of ['8.8.8.8', '1.1.1.1']) expect(isPublicIPv4(address)).toBe(true)
    for (const address of [
      'bad',
      '999.1.1.1',
      '0.0.0.0',
      '10.0.0.1',
      '127.0.0.1',
      '224.0.0.1',
      '100.64.0.1',
      '169.254.0.1',
      '172.16.0.1',
      '192.168.0.1',
      '192.0.0.1',
      '192.0.2.1',
      '198.18.0.1',
      '198.51.100.1',
      '203.0.113.1'
    ]) {
      expect(isPublicIPv4(address)).toBe(false)
    }
    expect(isPublicIPv6('2001:4860:4860::8888')).toBe(true)
    expect(isPublicIPv6('3001::1')).toBe(true)
    expect(isPublicIPv6('2001:db8::1')).toBe(false)
    expect(isPublicIPv6('::1')).toBe(false)
    await expect(requirePublicHost(new URL('https://8.8.8.8'))).resolves.toBeUndefined()
    await expect(requirePublicHost(new URL('https://127.0.0.1'))).rejects.toThrow('non-public')
    await expect(
      requirePublicHost(new URL('https://[2001:4860:4860::8888]'))
    ).resolves.toBeUndefined()
    expect(allowAnyHost()).toBeUndefined()
  })
})

describe('CLI commands', () => {
  test.each([{ arguments_: [] }, { arguments_: ['--help'] }, { arguments_: ['-h'] }])(
    'renders help for %#',
    async ({ arguments_ }) => {
      const { runtime, evidence } = fakeRuntime()
      await expect(runCHIRPCLI(arguments_, runtime)).resolves.toBe(0)
      expect(evidence.stdout.join('')).toContain('Usage:')
    }
  )

  test('reports unknown commands and non-Error command failures', async () => {
    const first = fakeRuntime()
    expect(await runCHIRPCLI(['unknown'], first.runtime)).toBe(1)
    expect(first.evidence.stderr.join('')).toContain('Unknown command')
    const second = fakeRuntime({ stat: async () => Promise.reject('stat failed') })
    expect(
      await runCHIRPCLI(
        [
          'publish',
          'file',
          '--host',
          'https://host.example',
          '--wallet-module',
          'wallet.mjs',
          '--retention-seconds',
          '60'
        ],
        second.runtime
      )
    ).toBe(1)
    expect(second.evidence.stderr.join('')).toContain('stat failed')
  })

  test('publishes with resume checkpoints and explicit local-development transport', async () => {
    const { runtime, evidence } = fakeRuntime({
      readFile: async () => JSON.stringify(CHECKPOINT)
    })
    const code = await runCHIRPCLI(
      [
        'publish',
        'file.bin',
        '--host',
        'https://a.example',
        '--host',
        'https://b.example',
        '--wallet-module',
        'wallet.mjs',
        '--retention-seconds',
        '60',
        '--resilience',
        '2',
        '--media-type',
        'application/octet-stream',
        '--resume-file',
        'resume.json',
        '--allow-insecure-http'
      ],
      runtime
    )
    expect(code).toBe(0)
    expect(evidence.uploaderConfig).toMatchObject({
      storageURLs: ['https://a.example', 'https://b.example'],
      resilienceLevel: 2,
      allowInsecureHTTP: true
    })
    expect(evidence.publishOptions).toMatchObject({
      retentionSeconds: '60',
      logicalLength: 3,
      mediaType: 'application/octet-stream',
      resume: CHECKPOINT
    })
    expect(evidence.writes).toEqual([expect.objectContaining({ path: 'resume.json', mode: 0o600 })])
    expect(JSON.parse(evidence.stdout.join(''))).toMatchObject({ objectCount: 2 })
  })

  test('accepts a missing resume file and validates required publish options', async () => {
    const successful = fakeRuntime()
    expect(
      await runCHIRPCLI(
        [
          'publish',
          'file.bin',
          '--host',
          'https://host.example',
          '--wallet-module',
          'wallet.mjs',
          '--retention-seconds',
          '60',
          '--resume-file',
          'missing.json'
        ],
        successful.runtime
      )
    ).toBe(0)
    const missing = fakeRuntime()
    expect(await runCHIRPCLI(['publish'], missing.runtime)).toBe(1)
    expect(
      await runCHIRPCLI(['publish', 'file.bin', '--host', 'https://host.example'], missing.runtime)
    ).toBe(1)
  })

  test('retrieves ordered chunks with backpressure and removes partial output on failure', async () => {
    const successful = fakeRuntime()
    expect(
      await runCHIRPCLI(
        [
          'retrieve',
          `chirp://${IDENTIFIER}`,
          '--output',
          'file.bin',
          '--range',
          '1:2',
          '--network',
          'testnet',
          '--concurrency',
          '2',
          '--allow-private-hosts',
          '--allow-insecure-http'
        ],
        successful.runtime
      )
    ).toBe(0)
    expect(successful.evidence.streamOptions).toEqual({
      range: { start: 1n, endExclusive: 2n }
    })
    expect(successful.evidence.downloaderConfig).toMatchObject({
      networkPreset: 'testnet',
      concurrency: 2,
      allowInsecureHTTP: true,
      urlPolicy: allowAnyHost
    })

    const failed = fakeRuntime({
      createDownloader: () => ({
        stream: () =>
          (async function* () {
            if (IDENTIFIER.length === 0) {
              yield { data: new Uint8Array(), logicalOffset: 0n, objectIdentifier: IDENTIFIER }
            }
            throw new Error('download failed')
          })(),
        inspect: async () => {
          throw new Error('unused')
        }
      })
    })
    expect(
      await runCHIRPCLI(
        ['retrieve', `chirp://${IDENTIFIER}`, '--output', 'partial.bin'],
        failed.runtime
      )
    ).toBe(1)
    expect(failed.evidence.destroyed).toBe(true)
    expect(failed.evidence.removed).toEqual(['partial.bin'])
  })

  test('verifies full content and validates retrieve/verify positionals', async () => {
    const verified = fakeRuntime()
    expect(
      await runCHIRPCLI(
        ['verify', `chirp://${IDENTIFIER}`, '--network', 'teratestnet'],
        verified.runtime
      )
    ).toBe(0)
    expect(JSON.parse(verified.evidence.stdout.join(''))).toMatchObject({
      verified: true,
      logicalLength: '2',
      contentHash: '0'.repeat(64)
    })
    const invalid = fakeRuntime()
    expect(await runCHIRPCLI(['retrieve'], invalid.runtime)).toBe(1)
    expect(await runCHIRPCLI(['retrieve', `chirp://${IDENTIFIER}`], invalid.runtime)).toBe(1)
    expect(await runCHIRPCLI(['verify'], invalid.runtime)).toBe(1)
  })
})

test('loads either supported wallet-module shape and rejects empty modules', async () => {
  const fixture = (name: string): string =>
    fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
  await expect(loadWallet(fixture('wallet-default.mjs'))).resolves.toMatchObject({
    kind: 'default-wallet'
  })
  await expect(loadWallet(fixture('wallet-factory.mjs'))).resolves.toMatchObject({
    kind: 'factory-wallet'
  })
  await expect(loadWallet(fixture('wallet-invalid.mjs'))).rejects.toThrow('Wallet module')
})
