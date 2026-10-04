import fc from 'fast-check'
import { createCipheriv } from 'node:crypto'
import { Brc39StreamFrame } from './Brc39Frame'
import { canonicalPortableChunks } from './CanonicalPortableChunks'
import { decryptBrc39StreamToQuarantine } from './Brc39StreamNode'
import { parseBRC38Json } from './index'
import {
  registerArgon2idBackend,
  unregisterArgon2idBackend,
  type AsyncArgon2idBackend
} from '../../utility/Argon2idBackend'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(MIN_PROPERTY_RUNS, Number(process.env.FAST_CHECK_NUM_RUNS ?? MIN_PROPERTY_RUNS)),
  seed: Number(process.env.FAST_CHECK_SEED ?? 3242026),
  ...(process.env.FAST_CHECK_PATH ? { path: process.env.FAST_CHECK_PATH } : {}),
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true
})

test('independent envelope bytes retain exactly ciphertext/tag under arbitrary bounded fragmentation', () => {
  const numRuns = Math.max(300, Number(process.env.FAST_CHECK_NUM_RUNS || 300))
  const seed = Number(process.env.FAST_CHECK_SEED || 3242026)
  fc.assert(
    fc.property(
      fc.uint8Array({ minLength: 1, maxLength: 4096 }),
      fc.uint8Array({ minLength: 16, maxLength: 16 }),
      fc.integer({ min: 1, max: 255 }),
      fc.integer({ min: 1, max: 255 }),
      fc.array(fc.integer({ min: 1, max: 128 }), { minLength: 1, maxLength: 15 }),
      (ciphertext, tag, saltLength, nonceLength, schedule) => {
        const prefix = Buffer.alloc(33 + saltLength + nonceLength, 0)
        prefix.write('WDAT')
        prefix.set([1, 1, 38, 1, 0, saltLength, nonceLength], 4)
        prefix.writeUInt32BE(7, 11)
        prefix.writeUInt32BE(131072, 15)
        prefix[19] = 1
        prefix[20] = 32
        prefix.fill(42, 33)
        const file = Buffer.concat([prefix, ciphertext, tag])
        const frame = new Brc39StreamFrame({
          maximumFileBytes: file.length,
          maximumChunkBytes: 128,
          maximumIterations: 7,
          maximumMemoryKiB: 131072,
          maximumParallelism: 1
        })
        const output: Uint8Array[] = []
        let offset = 0,
          step = 0
        while (offset < file.length) {
          const count = schedule[step++ % schedule.length]
          const chunk = file.subarray(offset, offset + count)
          const emitted = frame.accept(chunk)
          expect(emitted.every(value => value.length <= 128)).toBe(true)
          output.push(...emitted)
          offset += count
        }
        const header = frame.header()
        expect(header?.salt).toEqual(new Uint8Array(saltLength).fill(42))
        expect(header?.nonce).toEqual(new Uint8Array(nonceLength).fill(42))
        const result = frame.finish()
        expect(Buffer.concat(output)).toEqual(Buffer.from(ciphertext))
        expect(result.tag).toEqual(tag)
        expect(result.fileBytes).toBe(file.length)
        expect(result.ciphertextBytes).toBe(ciphertext.length)
      }
    ),
    {
      numRuns,
      seed,
      ...(process.env.FAST_CHECK_PATH ? { path: process.env.FAST_CHECK_PATH } : {}),
      interruptAfterTimeLimit: 150000,
      markInterruptAsFailure: true
    }
  )
}, 180000)

test('generated canonical documents, fragmentation and tag corruption preserve isolated authenticated processing', async () => {
  const key = new Uint8Array(32).fill(17)
  const backend: AsyncArgon2idBackend = {
    preload: async () => {},
    isReady: () => true,
    deriveKey: async value => {
      expect(value.password).toEqual(new TextEncoder().encode(' Caf\u00e9 '))
      expect(value).toMatchObject({ iterations: 1, memorySize: 64, parallelism: 1, hashLength: 32 })
      return key.slice()
    }
  }
  registerArgon2idBackend(backend)
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ maxLength: 1024 }),
        fc.integer({ min: 1, max: 100000 }),
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.array(fc.integer({ min: 1, max: 128 }), { minLength: 1, maxLength: 15 }),
        fc.boolean(),
        async (data, userId, salt, nonce, schedule, corrupt) => {
          const iso = '2026-10-03T00:00:00.000Z'
          const document = {
            brc: 38,
            title: 'User Wallet Data Format',
            formatVersion: 1,
            exportedAt: iso,
            sourceStorage: {
              created_at: iso,
              updated_at: iso,
              storageIdentityKey: 'source',
              storageName: 'synthetic-' + Buffer.from(data).toString('base64'),
              chain: 'test'
            },
            user: {
              created_at: iso,
              updated_at: iso,
              userId,
              identityKey: 'synthetic-' + userId,
              activeStorage: 'source'
            },
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
          const plaintext = Buffer.concat([
            ...canonicalPortableChunks(document, { maximumValueBytes: 1048576, maximumChunkBytes: 128 })
          ])
          // Independent standard envelope/native cipher; historical import work
          // is encoded exactly, while the selected host backend is controlled.
          const prefix = Buffer.alloc(97)
          prefix.write('WDAT')
          prefix.set([1, 1, 38, 1, 0, 32, 32], 4)
          prefix.writeUInt32BE(1, 11)
          prefix.writeUInt32BE(64, 15)
          prefix[19] = 1
          prefix[20] = 32
          prefix.set(salt, 33)
          prefix.set(nonce, 65)
          const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
          const file = Buffer.concat([prefix, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
          if (corrupt) file[file.length - 1] ^= 1
          async function* source() {
            let offset = 0,
              step = 0
            while (offset < file.length) {
              const count = schedule[step++ % schedule.length]
              yield new Uint8Array(file.subarray(offset, offset + count))
              offset += count
            }
          }
          const staged: Uint8Array[] = []
          let validated = 0,
            discarded = 0
          const quarantine = {
            appendUntrusted: async (bytes: Uint8Array) => {
              expect(bytes.length).toBeLessThanOrEqual(128)
              staged.push(bytes.slice())
            },
            validateAuthenticated: async () => {
              const bytes = Buffer.concat(staged)
              expect(bytes).toEqual(plaintext)
              expect(parseBRC38Json(new TextDecoder('utf-8', { fatal: true }).decode(bytes))).toEqual(document)
              validated++
            },
            discard: async () => {
              staged.splice(0)
              discarded++
            }
          }
          const pending = decryptBrc39StreamToQuarantine(source(), ' Cafe\u0301 ', quarantine, {
            maximumPasswordBytes: 1024,
            policy: {
              maximumFileBytes: file.length,
              maximumChunkBytes: 128,
              maximumIterations: 7,
              maximumMemoryKiB: 131072,
              maximumParallelism: 1
            }
          })
          if (corrupt) {
            await expect(pending).rejects.toThrow()
            expect(validated).toBe(0)
            expect(discarded).toBe(1)
            expect(staged).toHaveLength(0)
          } else {
            await expect(pending).resolves.toEqual({ fileBytes: file.length, plaintextBytes: plaintext.length })
            expect(validated).toBe(1)
            expect(discarded).toBe(0)
          }
        }
      ),
      {
        numRuns: Math.max(300, Number(process.env.FAST_CHECK_NUM_RUNS || 300)),
        seed: Number(process.env.FAST_CHECK_SEED || 3242026),
        ...(process.env.FAST_CHECK_PATH ? { path: process.env.FAST_CHECK_PATH } : {}),
        interruptAfterTimeLimit: 150000,
        markInterruptAsFailure: true
      }
    )
  } finally {
    unregisterArgon2idBackend(backend)
  }
}, 180000)
