import {
  canonicalTestReference,
  collectExpectedCanonicalChunks
} from '../../../test/utils/canonicalPortableChunkOracle'
import { createCipheriv } from 'node:crypto'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import type { Brc39StreamQuarantine, Brc39StreamPlaintext } from './Brc39StreamNode'
import { encodeBrc39StreamPrefix, BRC39_STREAM_DEFAULT_KDF, Brc39StreamFrame } from './Brc39Frame'
import type { BRC38WalletData } from './index'
import { canonicalPortableChunks } from './CanonicalPortableChunks'
import fc from 'fast-check'
import { AESGCM } from '@bsv/sdk/primitives/AESGCM'
import {
  registerArgon2idBackend,
  unregisterArgon2idBackend,
  type AsyncArgon2idBackend,
  type Argon2idOptions
} from '../../utility/Argon2idBackend'

let decryptBrc39StreamToQuarantine: typeof import('./Brc39StreamNode').decryptBrc39StreamToQuarantine
let encryptBrc39StreamToQuarantine: typeof import('./Brc39StreamNode').encryptBrc39StreamToQuarantine
let encryptBRC39: typeof import('./index').encryptBRC39
let decryptBRC39: typeof import('./index').decryptBRC39
let parseBRC38Json: typeof import('./index').parseBRC38Json
const nodeCrypto = require('node:crypto') as typeof import('node:crypto')

// Load real integration entries in awaited setup. Initialization guards must
// fail within the tests rather than preventing their assertions from loading.
beforeAll(async () => {
  const fixtureModule0 = await import('./Brc39StreamNode')
  decryptBrc39StreamToQuarantine = fixtureModule0.decryptBrc39StreamToQuarantine
  encryptBrc39StreamToQuarantine = fixtureModule0.encryptBrc39StreamToQuarantine
  const fixtureModule1 = await import('./index')
  encryptBRC39 = fixtureModule1.encryptBRC39
  decryptBRC39 = fixtureModule1.decryptBRC39
  parseBRC38Json = fixtureModule1.parseBRC38Json
})

// Real worker cases consume the ordinary compiled package entry. A TS test
// transpiler cannot execute a .ts worker as a production Node worker entry.
const compiledStream =
  require('../../../out/src/storage/portable/Brc39StreamNode.js') as typeof import('./Brc39StreamNode')

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(MIN_PROPERTY_RUNS, Number(process.env.FAST_CHECK_NUM_RUNS ?? MIN_PROPERTY_RUNS)),
  seed: Number(process.env.FAST_CHECK_SEED ?? 3242026),
  ...(process.env.FAST_CHECK_PATH ? { path: process.env.FAST_CHECK_PATH } : {}),
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true
})

const policy = {
  maximumFileBytes: 1048576,
  maximumChunkBytes: 128,
  maximumIterations: 7,
  maximumMemoryKiB: 131072,
  maximumParallelism: 1
}
const options = { policy, maximumPasswordBytes: 1024 }
const key = new Uint8Array(32).fill(17)
const nonce = new Uint8Array(32).fill(19)
const salt = new Uint8Array(32).fill(23)
function document(): BRC38WalletData {
  const iso = '2026-10-03T00:00:00.000Z'
  return {
    brc: 38,
    title: 'User Wallet Data Format',
    formatVersion: 1,
    exportedAt: iso,
    sourceStorage: {
      created_at: iso,
      updated_at: iso,
      storageIdentityKey: 'source',
      storageName: 'source',
      chain: 'test'
    },
    user: { created_at: iso, updated_at: iso, userId: 1, identityKey: 'identity', activeStorage: 'source' },
    tables: {
      provenTxs: [],
      provenTxReqs: [],
      outputBaskets: [],
      transactions: [],
      commissions: [],
      outputs: [],
      outputTags: [],
      outputTagMaps: [],
      txLabels: [],
      txLabelMaps: [],
      certificates: [],
      certificateFields: [],
      syncStates: []
    }
  }
}
function encrypted(plaintext = Buffer.from(JSON.stringify(document()))): Uint8Array {
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const prefix = encodeBrc39StreamPrefix(BRC39_STREAM_DEFAULT_KDF, salt, nonce, policy)
  return new Uint8Array(Buffer.concat([prefix, ciphertext, cipher.getAuthTag()]))
}
async function* chunks(bytes: Uint8Array, width = 31) {
  for (let offset = 0; offset < bytes.length; offset += width) yield bytes.slice(offset, offset + width)
}
function stage(): Brc39StreamQuarantine & { parts: Uint8Array[]; validated: number; discarded: number } {
  return {
    parts: [],
    validated: 0,
    discarded: 0,
    async appendUntrusted(bytes) {
      this.parts.push(bytes.slice())
    },
    async validateAuthenticated() {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(this.parts))
      parseBRC38Json(text)
      this.validated++
    },
    async discard() {
      this.parts = []
      this.discarded++
    }
  }
}
let backend: AsyncArgon2idBackend | undefined
beforeEach(() => {
  backend = { preload: async () => {}, isReady: () => true, deriveKey: async () => key.slice() }
  registerArgon2idBackend(backend)
})
afterEach(() => {
  if (backend !== undefined) unregisterArgon2idBackend(backend)
  jest.restoreAllMocks()
})

function plaintextSource(value = document(), width = 31): Brc39StreamPlaintext {
  const bytes = Buffer.concat(
    collectExpectedCanonicalChunks(
      canonicalPortableChunks(value, { maximumValueBytes: 1048576 }),
      canonicalTestReference(value)
    )
  )
  return {
    chunks: chunks(bytes, width),
    validateCompleted: async () => {
      expect(parseBRC38Json(bytes.toString())).toEqual(value)
    }
  }
}

test('owned source closes after semantic validation and before the authentication tag is written', async () => {
  const source = plaintextSource()
  const output = stage()
  const length = Buffer.concat(
    collectExpectedCanonicalChunks(
      canonicalPortableChunks(document(), { maximumValueBytes: 1048576 }),
      canonicalTestReference(document())
    )
  ).length
  const validate = source.validateCompleted
  let validated = false
  source.validateCompleted = async () => {
    await validate()
    validated = true
  }
  source.close = jest.fn(async () => {
    expect(validated).toBe(true)
    expect(Buffer.concat(output.parts)).toHaveLength(97 + length)
  })
  const receipt = await encryptBrc39StreamToQuarantine(source, 'password', output, options)
  expect(receipt.fileBytes).toBe(97 + length + 16)
  expect(source.close).toHaveBeenCalledTimes(1)
})

test('owned source close failure refuses the tag and retains exact cause with idempotent cleanup', async () => {
  const source = plaintextSource()
  const output = stage()
  const reason = new Error('synthetic source release failure')
  source.close = jest.fn(async () => {
    throw reason
  })
  await expect(encryptBrc39StreamToQuarantine(source, 'password', output, options)).rejects.toBe(reason)
  expect(source.close).toHaveBeenCalledTimes(2)
  expect(output.discarded).toBe(1)
  expect(output.parts).toEqual([])
})

test('output and owned source cleanup failures remain visible together', async () => {
  const source = plaintextSource()
  const output = stage()
  const original = new Error('synthetic private output failure')
  const cleanup = new Error('synthetic source cleanup failure')
  output.appendUntrusted = async () => {
    throw original
  }
  source.close = jest.fn(async () => {
    throw cleanup
  })
  await expect(encryptBrc39StreamToQuarantine(source, 'password', output, options)).rejects.toMatchObject({
    cause: original,
    errors: [original, cleanup]
  })
  expect(source.close).toHaveBeenCalledTimes(1)
  expect(output.discarded).toBe(1)
})
test.each([1, 15, 16, 17, 31, 33, 65, 97, 128])(
  'bounded encryption width %i produces a standard file accepted by the independent SDK codec',
  async width => {
    const output = stage()
    const source = plaintextSource(document(), width)
    let validated = 0
    const check = source.validateCompleted
    source.validateCompleted = async () => {
      await check()
      const provisional = Buffer.concat(output.parts)
      expect(provisional).toHaveLength(97 + Buffer.byteLength(JSON.stringify(document())))
      validated++
    }
    const progress: Array<Readonly<{ fileBytes: number; plaintextBytes: number }>> = []
    const result = await encryptBrc39StreamToQuarantine(source, 'Cafe\u0301', output, {
      ...options,
      policy: { ...policy, maximumChunkBytes: width },
      onProgress: value => progress.push(value)
    })
    const file = new Uint8Array(Buffer.concat(output.parts))
    expect(await decryptBRC39(file, 'Caf\u00e9')).toEqual(document())
    expect(validated).toBe(1)
    expect(output.discarded).toBe(0)
    expect(output.validated).toBe(0)
    expect(output.parts.every(part => part.length <= width)).toBe(true)
    expect(result).toEqual({ fileBytes: file.length, plaintextBytes: file.length - 113 })
    expect(Object.isFrozen(result)).toBe(true)
    expect(progress.at(-1)).toEqual(result)
    expect(progress.every(Object.isFrozen)).toBe(true)
  }
)
test('bounded encryption uses real canonical Argon2id strength and NFC with legacy decryption', async () => {
  unregisterArgon2idBackend(backend!)
  const output = stage()
  await compiledStream.encryptBrc39StreamToQuarantine(plaintextSource(), 'Cafe\u0301', output, options)
  expect(await decryptBRC39(new Uint8Array(Buffer.concat(output.parts)), 'Caf\u00e9')).toEqual(document())
}, 30000)
test('each new encryption owns fresh secure salt/nonce and exact canonical parameters', async () => {
  const headers = []
  for (let index = 0; index < 2; index++) {
    const output = stage()
    await encryptBrc39StreamToQuarantine(plaintextSource(), 'password', output, options)
    const frame = new Brc39StreamFrame({ ...policy, maximumChunkBytes: 65536 })
    frame.accept(new Uint8Array(Buffer.concat(output.parts)))
    const header = frame.header()!
    expect(header).toMatchObject(BRC39_STREAM_DEFAULT_KDF)
    expect(header.salt).toHaveLength(32)
    expect(header.nonce).toHaveLength(32)
    const plaintext = Buffer.concat(
      collectExpectedCanonicalChunks(
        canonicalPortableChunks(document(), { maximumValueBytes: 1048576 }),
        canonicalTestReference(document())
      )
    )
    const independent = AESGCM(new Uint8Array(plaintext), header.nonce, key)
    const file = Buffer.concat(output.parts)
    expect(file.subarray(97, file.length - 16)).toEqual(Buffer.from(independent.result))
    expect(file.subarray(file.length - 16)).toEqual(Buffer.from(independent.authenticationTag))
    headers.push(header)
  }
  expect(headers[0].salt).not.toEqual(headers[1].salt)
  expect(headers[0].nonce).not.toEqual(headers[1].nonce)
})
test.each([
  { ...options, kdf: { iterations: 6, memoryKiB: 131072, parallelism: 1 } },
  { ...options, kdf: { iterations: 7, memoryKiB: 131071, parallelism: 1 } },
  { ...options, policy: { ...policy, maximumIterations: 6 } },
  { ...options, policy: { ...policy, maximumFileBytes: 113 } },
  { ...options, maximumPasswordBytes: 3 }
])('invalid or weaker export work policy never derives or writes', async variant => {
  const derive = jest.fn(async () => key.slice())
  backend!.deriveKey = derive
  const output = stage()
  await expect(encryptBrc39StreamToQuarantine(plaintextSource(), 'password', output, variant)).rejects.toThrow()
  expect(derive).not.toHaveBeenCalled()
  expect(output.parts).toHaveLength(0)
  expect(output.discarded).toBe(1)
})
test('export file admission includes prefix and reserved tag and refuses oversized chunks', async () => {
  const bytes = Buffer.concat(
    collectExpectedCanonicalChunks(
      canonicalPortableChunks(document(), { maximumValueBytes: 1048576 }),
      canonicalTestReference(document())
    )
  )
  const variants = [
    { ...options, policy: { ...policy, maximumFileBytes: bytes.length + 112 } },
    { ...options, policy: { ...policy, maximumChunkBytes: 30 } }
  ]
  for (const variant of variants) {
    const output = stage()
    const source = plaintextSource()
    const validate = jest.fn(source.validateCompleted)
    source.validateCompleted = validate
    await expect(encryptBrc39StreamToQuarantine(source, 'password', output, variant)).rejects.toThrow()
    expect(validate).not.toHaveBeenCalled()
    expect(output.parts).toHaveLength(0)
    expect(output.discarded).toBe(1)
  }
})
test('empty or semantically refused plaintext cannot finish an export', async () => {
  const failure = new Error('synthetic incomplete source semantics')
  const refused = plaintextSource()
  refused.validateCompleted = async () => {
    throw failure
  }
  const output = stage()
  await expect(encryptBrc39StreamToQuarantine(refused, 'password', output, options)).rejects.toBe(failure)
  expect(output.parts).toHaveLength(0)
  expect(output.discarded).toBe(1)
  const empty = stage()
  await expect(
    encryptBrc39StreamToQuarantine(
      { chunks: chunks(new Uint8Array()), validateCompleted: async () => {} },
      'password',
      empty,
      options
    )
  ).rejects.toThrow('empty')
  expect(empty.discarded).toBe(1)
})
test('encryption source, progress and discard failures retain original causes', async () => {
  const failure = new Error('synthetic export source failure')
  const cleanup = new Error('synthetic export cleanup failure')
  const output = stage()
  output.discard = async () => {
    throw cleanup
  }
  async function* broken() {
    yield new Uint8Array([1])
    throw failure
  }
  try {
    await encryptBrc39StreamToQuarantine(
      { chunks: broken(), validateCompleted: async () => {} },
      'password',
      output,
      options
    )
    throw new Error('expected refusal')
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([failure, cleanup])
    expect((error as Error).cause).toBe(failure)
  }
  const progressOutput = stage()
  await expect(
    encryptBrc39StreamToQuarantine(plaintextSource(), 'password', progressOutput, {
      ...options,
      onProgress: () => {
        throw failure
      }
    })
  ).rejects.toBe(failure)
  expect(progressOutput.discarded).toBe(1)
})
test('pending export output settles before cancellation cleanup and source cannot advance', async () => {
  const controller = new AbortController()
  const reason = new Error('synthetic export cancellation')
  const output = stage()
  let release!: () => void
  let entered!: () => void
  const writing = new Promise<void>(resolve => {
    entered = resolve
  })
  const blocked = new Promise<void>(resolve => {
    release = resolve
  })
  let chunksRead = 0
  const source = plaintextSource()
  const original = source.chunks
  async function* counted() {
    for await (const chunk of original) {
      chunksRead++
      yield chunk
    }
  }
  source.chunks = counted()
  output.appendUntrusted = async () => {
    entered()
    await blocked
  }
  const operation = encryptBrc39StreamToQuarantine(source, 'password', output, {
    ...options,
    signal: controller.signal
  })
  const checked = expect(operation).rejects.toBe(reason)
  await writing
  controller.abort(reason)
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(output.discarded).toBe(0)
    expect(chunksRead).toBe(0)
  } finally {
    release()
    await checked
  }
  expect(output.discarded).toBe(1)
})
test('generated bounded exports preserve independent codec bytes and reject corrupted complete tags', async () => {
  const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
  const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
  const replayPath = process.env.FAST_CHECK_PATH
  await fc.assert(
    fc.asyncProperty(
      fc.uint8Array({ maxLength: 2048 }),
      fc.integer({ min: 1, max: 128 }),
      fc.boolean(),
      async (payload, width, corrupt) => {
        const value = document()
        value.sourceStorage.storageName = 'synthetic-' + Buffer.from(payload).toString('base64')
        const output = stage()
        await encryptBrc39StreamToQuarantine(plaintextSource(value, width), 'Cafe\u0301', output, {
          ...options,
          policy: { ...policy, maximumChunkBytes: width }
        })
        const file = new Uint8Array(Buffer.concat(output.parts))
        if (corrupt) {
          file[file.length - 1] ^= 1
          await expect(decryptBRC39(file, 'Caf\u00e9')).rejects.toThrow()
        } else expect(await decryptBRC39(file, 'Caf\u00e9')).toEqual(value)
        expect(output.parts.every(part => part.length <= width)).toBe(true)
        expect(output.discarded).toBe(0)
      }
    ),
    {
      numRuns: Number.isSafeInteger(requestedRuns) ? Math.max(300, requestedRuns) : 300,
      seed: Number.isSafeInteger(requestedSeed) ? requestedSeed : 3242026,
      ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {}),
      interruptAfterTimeLimit: 150000,
      markInterruptAsFailure: true
    }
  )
}, 180000)
test.each([1, 15, 16, 17, 31, 33, 65, 97, 128])(
  'bounded decrypt width %i authenticates before semantics and reports complete bytes',
  async width => {
    const bytes = encrypted()
    const quarantine = stage()
    const progress: Array<Readonly<{ fileBytes: number; plaintextBytes: number }>> = []
    const result = await decryptBrc39StreamToQuarantine(chunks(bytes, width), 'Cafe\u0301', quarantine, {
      ...options,
      onProgress: value => progress.push(value)
    })
    expect(quarantine.validated).toBe(1)
    expect(quarantine.discarded).toBe(0)
    expect(Buffer.concat(quarantine.parts).toString()).toBe(JSON.stringify(document()))
    expect(quarantine.parts.every(part => part.length <= width)).toBe(true)
    expect(result).toEqual({ fileBytes: bytes.length, plaintextBytes: Buffer.byteLength(JSON.stringify(document())) })
    expect(Object.isFrozen(result)).toBe(true)
    expect(progress.at(-1)).toEqual(result)
    expect(progress.every(Object.isFrozen)).toBe(true)
  }
)
test('existing materialized canonical export decrypts with real Argon2id/NFC and native GCM', async () => {
  unregisterArgon2idBackend(backend!)
  const bytes = new Uint8Array(await encryptBRC39(document(), 'Cafe\u0301'))
  const quarantine = stage()
  const result = await compiledStream.decryptBrc39StreamToQuarantine(
    chunks(bytes, 97),
    'Caf\u00e9',
    quarantine,
    options
  )
  expect(result.fileBytes).toBe(bytes.length)
  expect(quarantine.validated).toBe(1)
  expect(parseBRC38Json(Buffer.concat(quarantine.parts).toString())).toEqual(document())
  const rejected = stage()
  await expect(
    compiledStream.decryptBrc39StreamToQuarantine(chunks(bytes, 97), 'different password', rejected, options)
  ).rejects.toThrow()
  expect(rejected.validated).toBe(0)
  expect(rejected.discarded).toBe(1)
}, 30000)
test.each(['tag', 'ciphertext', 'wrong key'])(
  'authentication failure for %s never validates or exposes a successful receipt',
  async mode => {
    const bytes = encrypted()
    if (mode === 'tag') bytes[bytes.length - 1] ^= 1
    else if (mode === 'ciphertext') bytes[100] ^= 1
    else backend!.deriveKey = async () => new Uint8Array(32).fill(4)
    const quarantine = stage()
    await expect(decryptBrc39StreamToQuarantine(chunks(bytes), 'password', quarantine, options)).rejects.toThrow()
    expect(quarantine.validated).toBe(0)
    expect(quarantine.discarded).toBe(1)
    expect(quarantine.parts).toHaveLength(0)
  }
)
test.each([Buffer.from('{"brc":37}'), Buffer.from([0xff, 0xfe])])(
  'authenticated invalid semantics or UTF8 are discarded',
  async plaintext => {
    const quarantine = stage()
    await expect(
      decryptBrc39StreamToQuarantine(chunks(encrypted(plaintext)), 'password', quarantine, options)
    ).rejects.toThrow()
    expect(quarantine.validated).toBe(0)
    expect(quarantine.discarded).toBe(1)
  }
)
test('selected backend receives exact NFC bytes and encoded KDF parameters without trimming', async () => {
  const derive = jest.fn(async (value: Readonly<Argon2idOptions>) => key.slice(0, value.hashLength))
  backend!.deriveKey = derive
  await decryptBrc39StreamToQuarantine(chunks(encrypted()), ' Cafe\u0301 ', stage(), options)
  expect(derive).toHaveBeenCalledTimes(1)
  expect(derive.mock.calls[0]).toHaveLength(1)
  const received = derive.mock.calls[0][0]
  expect(received).toMatchObject({ iterations: 7, memorySize: 131072, parallelism: 1, hashLength: 32 })
  // The owned password array is wiped after the backend settles; capture the
  // input while deriving to check encoding in a separate call.
  let passwordBytes: Uint8Array | undefined
  backend!.deriveKey = async value => {
    passwordBytes = value.password.slice()
    return key.slice()
  }
  await decryptBrc39StreamToQuarantine(chunks(encrypted()), ' Cafe\u0301 ', stage(), options)
  expect(passwordBytes).toEqual(new TextEncoder().encode(' Caf\u00e9 '))
})
test('backend failure preserves exact identity without fallback and discards staging', async () => {
  const failure = new Error('synthetic selected backend failure')
  backend!.deriveKey = async () => {
    throw failure
  }
  const quarantine = stage()
  await expect(decryptBrc39StreamToQuarantine(chunks(encrypted()), 'password', quarantine, options)).rejects.toBe(
    failure
  )
  expect(quarantine.discarded).toBe(1)
})

test.each([
  ['encrypt', 'completed'],
  ['encrypt', 'failed'],
  ['decrypt', 'completed'],
  ['decrypt', 'failed']
] as const)('the original derived key is erased after %s %s settlement', async (mode, outcome) => {
  const derived = key.slice()
  backend!.deriveKey = async () => derived
  const quarantine = stage()
  const failure = new Error('synthetic private write failure')
  if (outcome === 'failed')
    quarantine.appendUntrusted = async () => {
      throw failure
    }
  const operation =
    mode === 'encrypt'
      ? encryptBrc39StreamToQuarantine(plaintextSource(), 'password', quarantine, options)
      : decryptBrc39StreamToQuarantine(chunks(encrypted()), 'password', quarantine, options)
  if (outcome === 'failed') {
    await expect(operation).rejects.toBe(failure)
    expect(quarantine.discarded).toBe(1)
  } else {
    await expect(operation).resolves.toMatchObject({ plaintextBytes: expect.any(Number) })
  }
  expect(derived).toEqual(new Uint8Array(32))
  expect(key).toEqual(new Uint8Array(32).fill(17))
})

test.each(['encrypt', 'decrypt'] as const)(
  'encoded password refusal wipes its owned bytes before %s cleanup',
  async mode => {
    const fill = jest.spyOn(Uint8Array.prototype, 'fill')
    const derive = jest.spyOn(backend!, 'deriveKey')
    const quarantine = stage()
    const variant = { ...options, maximumPasswordBytes: 2 }
    const operation =
      mode === 'encrypt'
        ? encryptBrc39StreamToQuarantine(plaintextSource(), '🙂', quarantine, variant)
        : decryptBrc39StreamToQuarantine(chunks(encrypted()), '🙂', quarantine, variant)
    await expect(operation).rejects.toThrow('encoded password exceeds')
    expect(derive).not.toHaveBeenCalled()
    expect(fill).toHaveBeenCalledWith(0)
    const owned = fill.mock.contexts.find(bytes => bytes.length === 4)
    expect(owned).toBeDefined()
    expect(Array.from(owned!)).toEqual([0, 0, 0, 0])
    expect(quarantine.discarded).toBe(1)
  }
)
test('invalid work/file/chunk/password policy refuses before backend derivation', async () => {
  let derived = 0
  backend!.deriveKey = async () => {
    derived++
    return key.slice()
  }
  const variants = [
    { ...options, policy: { ...policy, maximumIterations: 1 } },
    { ...options, policy: { ...policy, maximumFileBytes: 50 } },
    { ...options, policy: { ...policy, maximumChunkBytes: 30 } },
    { ...options, maximumPasswordBytes: 0 },
    { ...options, maximumPasswordBytes: 3 }
  ]
  for (const variant of variants) {
    const quarantine = stage()
    await expect(decryptBrc39StreamToQuarantine(chunks(encrypted()), 'password', quarantine, variant)).rejects.toThrow()
    expect(quarantine.discarded).toBe(1)
  }
  expect(derived).toBe(0)
})
test('cancellation waits for pending staging, closes source and keeps exact reason', async () => {
  const controller = new AbortController()
  const reason = new Error('synthetic cancellation')
  const quarantine = stage()
  let settle: (() => void) | undefined
  let signalWrite: (() => void) | undefined
  const entered = new Promise<void>(resolve => {
    signalWrite = resolve
  })
  quarantine.appendUntrusted = async () =>
    new Promise<void>(resolve => {
      settle = resolve
      signalWrite!()
    })
  let closed = false
  async function* source() {
    try {
      yield encrypted().slice(0, 128)
      throw new Error('must not request another chunk')
    } finally {
      closed = true
    }
  }
  let finished = false
  const pending = decryptBrc39StreamToQuarantine(source(), 'password', quarantine, {
    ...options,
    signal: controller.signal
  }).finally(() => {
    finished = true
  })
  await entered
  controller.abort(reason)
  await Promise.resolve()
  expect(finished).toBe(false)
  expect(quarantine.discarded).toBe(0)
  settle!()
  await expect(pending).rejects.toBe(reason)
  expect(closed).toBe(true)
  expect(quarantine.discarded).toBe(1)
})
test('source and quarantine cleanup failures retain both exact causes', async () => {
  const sourceFailure = new Error('synthetic source failure')
  const cleanupFailure = new Error('synthetic quarantine cleanup failure')
  async function* source() {
    yield encrypted().slice(0, 128)
    throw sourceFailure
  }
  const quarantine = stage()
  quarantine.discard = async () => {
    throw cleanupFailure
  }
  let caught: unknown
  try {
    await decryptBrc39StreamToQuarantine(source(), 'password', quarantine, options)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(AggregateError)
  expect((caught as AggregateError).errors).toEqual([sourceFailure, cleanupFailure])
  expect((caught as Error).cause).toBe(sourceFailure)
})

test('combined KDF and quarantine cleanup failure retains concrete original retry owners in order', async () => {
  const order: string[] = [],
    keyFailure = new Brc38StagingCleanupError([new Error('key remains owned')], 'key cleanup', async () => {
      order.push('key')
    }),
    quarantineFailure = new Brc38StagingCleanupError([new Error('stage remains owned')], 'stage cleanup', async () => {
      order.push('stage')
    })
  backend!.deriveKey = async () => {
    throw keyFailure
  }
  const quarantine = stage()
  let first = true
  quarantine.discard = async () => {
    if (first) {
      first = false
      throw quarantineFailure
    }
    order.push('discard')
  }
  let caught: unknown
  try {
    await decryptBrc39StreamToQuarantine(chunks(encrypted()), 'private', quarantine, options)
  } catch (cause) {
    caught = cause
  }
  expect(caught).toBeInstanceOf(Brc38StagingCleanupError)
  expect((caught as Brc38StagingCleanupError).cause).toBe(keyFailure)
  await (caught as Brc38StagingCleanupError).retryCleanup()
  expect(order).toEqual(['key', 'stage', 'discard'])
})

// These negative tests keep the actual cipher objects and their real cleanup.
// Deliberately broken return values model a backend contract failure; they do
// not replace the real native GCM/Argon2id positive cases above.
test.each([false, true])('encryption source retry preserves concrete cleanup owners: retryable=%s', async retryable => {
  const order: string[] = []
  const primary = retryable
    ? new Brc38StagingCleanupError([new Error('source remains owned')], 'source failure', async () => {
        order.push('original owner')
      })
    : new Error('source failure')
  const cleanup = retryable
    ? new Brc38StagingCleanupError([new Error('close remains owned')], 'close failure', async () => {
        order.push('close owner')
      })
    : new Error('close failure')
  const source = plaintextSource(),
    output = stage()
  let refuseClose = true
  source.chunks = (async function* () {
    yield new Uint8Array([1])
    throw primary
  })()
  source.close = jest.fn(async () => {
    if (refuseClose) throw cleanup
    order.push('source closed')
  })
  const operation = encryptBrc39StreamToQuarantine(source, 'password', output, options)
  const failure: unknown = await operation.then(
    () => undefined,
    cause => cause
  )
  expect(failure).toBeInstanceOf(Brc38StagingCleanupError)
  if (!(failure instanceof Brc38StagingCleanupError)) throw new Error('Source cleanup owner was lost')
  expect(failure.message).toBe('BRC-39 encryption and source cleanup failed')
  expect(failure.cause).toBe(primary)
  expect(failure.errors).toEqual([primary, cleanup])
  expect(output.discarded).toBe(1)
  expect(output.parts).toEqual([])
  refuseClose = false
  await failure.retryCleanup()
  expect(order).toEqual(retryable ? ['original owner', 'close owner', 'source closed'] : ['source closed'])
  expect(source.close).toHaveBeenCalledTimes(2)
})

test('malformed plaintext chunks refuse and discard before semantic validation', async () => {
  const source = plaintextSource(),
    output = stage()
  source.chunks = (async function* () {
    yield 'invalid bytes' as unknown as Uint8Array
  })()
  source.validateCompleted = jest.fn(source.validateCompleted)
  await expect(encryptBrc39StreamToQuarantine(source, 'password', output, options)).rejects.toThrow(
    'BRC-39 plaintext stream requires byte chunks'
  )
  expect(source.validateCompleted).not.toHaveBeenCalled()
  expect(output.discarded).toBe(1)
  expect(output.parts).toEqual([])
})

test('unavailable native GCM capability refuses before deriving a password key', async () => {
  const packet = encrypted(),
    quarantine = stage(),
    derive = jest.spyOn(backend!, 'deriveKey')
  jest.spyOn(nodeCrypto, 'getCipherInfo').mockReturnValue(undefined)
  await expect(decryptBrc39StreamToQuarantine(chunks(packet), 'password', quarantine, options)).rejects.toThrow(
    'Selected Node AES-GCM backend cannot process this BRC-39 nonce length'
  )
  expect(derive).not.toHaveBeenCalled()
  expect(quarantine.validated).toBe(0)
  expect(quarantine.discarded).toBe(1)
})

test.each(['encrypt', 'decrypt'] as const)(
  'missing %s context refuses and erases its owned derived key',
  async mode => {
    const packet = encrypted(),
      output = stage()
    let issued: Uint8Array | undefined, consumed: Uint8Array | undefined
    backend!.deriveKey = async () => (issued = key.slice())
    const captureKey = (actualKey: unknown): void => {
      if (!(actualKey instanceof Uint8Array)) throw new Error('Actual stream key was not owned bytes')
      consumed = actualKey
    }
    if (mode === 'encrypt')
      jest.spyOn(nodeCrypto, 'createCipheriv').mockImplementation((...args) => {
        captureKey(args[1])
        return undefined as unknown as ReturnType<typeof nodeCrypto.createCipheriv>
      })
    else
      jest.spyOn(nodeCrypto, 'createDecipheriv').mockImplementation((...args) => {
        captureKey(args[1])
        return undefined as unknown as ReturnType<typeof nodeCrypto.createDecipheriv>
      })
    const operation =
      mode === 'encrypt'
        ? encryptBrc39StreamToQuarantine(plaintextSource(), 'password', output, options)
        : decryptBrc39StreamToQuarantine(chunks(packet), 'password', output, options)
    await expect(operation).rejects.toThrow(
      mode === 'encrypt' ? 'BRC-39 encryption context is closed' : 'BRC-39 ciphertext arrived before a complete header'
    )
    expect(issued).toBeDefined()
    expect([...issued!]).toEqual(Array.from({ length: 32 }, () => 0))
    expect(consumed).toBeDefined()
    expect([...consumed!]).toEqual(Array.from({ length: 32 }, () => 0))
    expect(output.discarded).toBe(1)
    expect(output.validated).toBe(0)
  }
)

test('a parser that loses its header cannot finish a ciphertext stream without a decryptor', async () => {
  const packet = encrypted(),
    quarantine = stage(),
    accept = Brc39StreamFrame.prototype.accept
  const derive = jest.spyOn(backend!, 'deriveKey')
  jest.spyOn(Brc39StreamFrame.prototype, 'accept').mockImplementation(function (this: Brc39StreamFrame, bytes) {
    // Retain the actual frame accounting and complete packet validation while
    // injecting loss of its delivered chunks/header at the parser boundary.
    Reflect.apply(accept, this, [bytes])
    return []
  })
  jest.spyOn(Brc39StreamFrame.prototype, 'header').mockReturnValue(undefined)
  await expect(decryptBrc39StreamToQuarantine(chunks(packet), 'password', quarantine, options)).rejects.toThrow(
    'BRC-39 stream has no decryptor'
  )
  expect(derive).not.toHaveBeenCalled()
  expect(quarantine.discarded).toBe(1)
  expect(quarantine.validated).toBe(0)
})

test.each(['encrypt', 'decrypt'] as const)('actual %s cipher buffering refuses unvalidated output', async mode => {
  const packet = encrypted(),
    output = stage()
  if (mode === 'encrypt') {
    const create = nodeCrypto.createCipheriv
    jest.spyOn(nodeCrypto, 'createCipheriv').mockImplementation((...args) => {
      const actual = Reflect.apply(create, nodeCrypto, args) as ReturnType<typeof create>
      const update = actual.update
      jest.spyOn(actual, 'update').mockImplementationOnce((...input) => {
        Reflect.apply(update, actual, input)
        return Buffer.alloc(0) as unknown as ReturnType<typeof actual.update>
      })
      return actual
    })
  } else {
    const create = nodeCrypto.createDecipheriv
    jest.spyOn(nodeCrypto, 'createDecipheriv').mockImplementation((...args) => {
      const actual = Reflect.apply(create, nodeCrypto, args) as ReturnType<typeof create>
      const update = actual.update
      jest.spyOn(actual, 'update').mockImplementationOnce((...input) => {
        Reflect.apply(update, actual, input)
        return Buffer.alloc(0) as unknown as ReturnType<typeof actual.update>
      })
      return actual
    })
  }
  const operation =
    mode === 'encrypt'
      ? encryptBrc39StreamToQuarantine(plaintextSource(), 'password', output, options)
      : decryptBrc39StreamToQuarantine(chunks(packet), 'password', output, options)
  await expect(operation).rejects.toThrow(
    mode === 'encrypt'
      ? 'Selected GCM backend buffered ciphertext'
      : 'Selected GCM backend buffered provisional plaintext'
  )
  expect(output.discarded).toBe(1)
  expect(output.parts).toEqual([])
  expect(output.validated).toBe(0)
})

test.each(['encrypt', 'decrypt'] as const)('actual %s final buffering refuses completion', async mode => {
  const packet = encrypted(),
    output = stage()
  if (mode === 'encrypt') {
    const create = nodeCrypto.createCipheriv
    jest.spyOn(nodeCrypto, 'createCipheriv').mockImplementation((...args) => {
      const actual = Reflect.apply(create, nodeCrypto, args) as ReturnType<typeof create>
      const finish = actual.final
      jest.spyOn(actual, 'final').mockImplementationOnce((...input) => {
        Reflect.apply(finish, actual, input)
        return Buffer.from([1]) as unknown as ReturnType<typeof actual.final>
      })
      return actual
    })
  } else {
    const create = nodeCrypto.createDecipheriv
    jest.spyOn(nodeCrypto, 'createDecipheriv').mockImplementation((...args) => {
      const actual = Reflect.apply(create, nodeCrypto, args) as ReturnType<typeof create>
      const finish = actual.final
      jest.spyOn(actual, 'final').mockImplementationOnce((...input) => {
        Reflect.apply(finish, actual, input)
        return Buffer.from([1]) as unknown as ReturnType<typeof actual.final>
      })
      return actual
    })
  }
  const operation =
    mode === 'encrypt'
      ? encryptBrc39StreamToQuarantine(plaintextSource(), 'password', output, options)
      : decryptBrc39StreamToQuarantine(chunks(packet), 'password', output, options)
  await expect(operation).rejects.toThrow(
    mode === 'encrypt'
      ? 'Selected GCM backend buffered final ciphertext'
      : 'Selected GCM backend did not preserve the complete plaintext length'
  )
  expect(output.discarded).toBe(1)
  expect(output.parts).toEqual([])
  expect(output.validated).toBe(0)
})

test.each(['encrypt', 'decrypt'] as const)(
  'actual %s crypto close failure preserves both causes and erases its key',
  async mode => {
    const packet = encrypted(),
      output = stage(),
      source = plaintextSource()
    const primary = new Error('original physical stream failure'),
      cleanup = new Error('actual cipher destroy failure')
    let issued: Uint8Array | undefined, consumed: Uint8Array | undefined
    backend!.deriveKey = async () => (issued = key.slice())
    const captureKey = (actualKey: unknown): void => {
      if (!(actualKey instanceof Uint8Array)) throw new Error('Actual stream key was not owned bytes')
      consumed = actualKey
    }
    const failDestroy = (
      cipher: ReturnType<typeof nodeCrypto.createCipheriv> | ReturnType<typeof nodeCrypto.createDecipheriv>
    ) => {
      const destroy = cipher.destroy.bind(cipher)
      jest.spyOn(cipher, 'destroy').mockImplementationOnce(() => {
        destroy()
        throw cleanup
      })
      return cipher
    }
    if (mode === 'encrypt') {
      const create = nodeCrypto.createCipheriv
      jest.spyOn(nodeCrypto, 'createCipheriv').mockImplementation((...args) => {
        captureKey(args[1])
        return failDestroy(Reflect.apply(create, nodeCrypto, args)) as ReturnType<typeof create>
      })
      source.chunks = (async function* () {
        yield new Uint8Array([1])
        throw primary
      })()
    } else {
      const create = nodeCrypto.createDecipheriv
      jest.spyOn(nodeCrypto, 'createDecipheriv').mockImplementation((...args) => {
        captureKey(args[1])
        return failDestroy(Reflect.apply(create, nodeCrypto, args)) as ReturnType<typeof create>
      })
      output.appendUntrusted = async () => {
        throw primary
      }
    }
    const operation =
      mode === 'encrypt'
        ? encryptBrc39StreamToQuarantine(source, 'password', output, options)
        : decryptBrc39StreamToQuarantine(chunks(packet), 'password', output, options)
    const failure: unknown = await operation.then(
      () => undefined,
      cause => cause
    )
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).message).toBe(
      mode === 'encrypt' ? 'BRC-39 encryption and crypto cleanup failed' : 'BRC-39 processing and crypto cleanup failed'
    )
    expect((failure as AggregateError).cause).toBe(primary)
    expect((failure as AggregateError).errors).toEqual([primary, cleanup])
    expect(issued).toBeDefined()
    expect([...issued!]).toEqual(Array.from({ length: 32 }, () => 0))
    expect(consumed).toBeDefined()
    expect([...consumed!]).toEqual(Array.from({ length: 32 }, () => 0))
    expect(output.discarded).toBe(1)
    expect(output.parts).toEqual([])
    expect(output.validated).toBe(0)
  }
)

test.each(
  [0, -1, 1.5, NaN, Infinity, 65537].flatMap(maximumPasswordBytes =>
    (['encrypt', 'decrypt'] as const).map(mode => ({ maximumPasswordBytes, mode }))
  )
)(
  'invalid password policy $maximumPasswordBytes refuses $mode before KDF and cipher ownership',
  async ({ maximumPasswordBytes, mode }) => {
    const packet = encrypted(),
      output = stage(),
      derive = jest.spyOn(backend!, 'deriveKey'),
      cipher = jest.spyOn(nodeCrypto, 'createCipheriv'),
      decipher = jest.spyOn(nodeCrypto, 'createDecipheriv'),
      selected = { ...options, maximumPasswordBytes }
    const operation =
      mode === 'encrypt'
        ? encryptBrc39StreamToQuarantine(plaintextSource(), 'x', output, selected)
        : decryptBrc39StreamToQuarantine(chunks(packet), 'x', output, selected)
    await expect(operation).rejects.toBeInstanceOf(RangeError)
    await expect(operation).rejects.toThrow('maximumPasswordBytes must be an integer from 1 to 65536')
    expect(derive).not.toHaveBeenCalled()
    expect(cipher).not.toHaveBeenCalled()
    expect(decipher).not.toHaveBeenCalled()
    expect(output.discarded).toBe(1)
    expect(output.parts).toEqual([])
  }
)

test.each([1, 65536])(
  'exact password policy limit %s retains real GCM encryption and decryption',
  async maximumPasswordBytes => {
    const output = stage(),
      quarantine = stage(),
      selected = { ...options, maximumPasswordBytes }
    const encryptedReceipt = await encryptBrc39StreamToQuarantine(plaintextSource(), 'x', output, selected)
    const decryptedReceipt = await decryptBrc39StreamToQuarantine(
      chunks(Buffer.concat(output.parts)),
      'x',
      quarantine,
      selected
    )
    expect(decryptedReceipt).toEqual(encryptedReceipt)
    expect(quarantine.validated).toBe(1)
    expect(quarantine.discarded).toBe(0)
    expect(output.discarded).toBe(0)
  }
)
