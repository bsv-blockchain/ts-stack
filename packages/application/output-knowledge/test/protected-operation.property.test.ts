import { expect, test } from '@jest/globals'
import fc from 'fast-check'
import { IDBFactory } from 'fake-indexeddb'
import {
  CompletedProtoWallet,
  PrivateKey,
  canonicalOutputJSON,
  type OutputJSONObject
} from '@bsv/sdk'
import { IndexedDBOperationStateStore } from '../src/operations/IndexedDBOperationStateStore.js'
import {
  ProtectedOperationStateStore,
  protectedOperationBinding,
  PROTECTED_OPERATION_INITIAL
} from '../src/operations/ProtectedOperationStateStore.js'
import { WalletProtectedOperationPayload } from '../src/operations/WalletProtectedOperationPayload.js'
const MIN_PROPERTY_RUNS = 300
const runs = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10),
  seed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10),
  path = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(runs) ? Math.max(MIN_PROPERTY_RUNS, runs) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(seed) ? { seed } : {}),
  ...(path ? { path } : {})
})
test(
  'Generated IndexedDB CAS histories preserve encrypted original state through competing writes, retries and reopen',
  async () => {
    const key = new PrivateKey(84),
      wallet = new CompletedProtoWallet(key)
    const makeCodec = () =>
      new WalletProtectedOperationPayload(wallet, key.toPublicKey().toString(), 2048)
    const options = {
      binding: { account: 'synthetic-recipient', installation: 'original' },
      maximumValueBytes: 1024
    }
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            value: fc.integer({ min: 0, max: 99999 }),
            stale: fc.boolean(),
            replay: fc.boolean(),
            reopen: fc.boolean()
          }),
          { minLength: 1, maxLength: 7 }
        ),
        async history => {
          const factory = new IDBFactory(),
            codec = makeCodec(),
            binding = protectedOperationBinding(options, codec)
          const first = await IndexedDBOperationStateStore.create(
            'protected-generated',
            'buyer',
            binding,
            PROTECTED_OPERATION_INITIAL,
            { factory }
          )
          const bases = [first]
          const clients = [
            await ProtectedOperationStateStore.initialize(first, codec, options, {
              sequence: 0,
              private: 'retained-original-private-marker'
            })
          ]
          let expected: OutputJSONObject = {
              sequence: 0,
              private: 'retained-original-private-marker'
            },
            revision = 1
          try {
            for (const [index, step] of history.entries()) {
              if (step.reopen) {
                const base = await IndexedDBOperationStateStore.open(
                  'protected-generated',
                  'buyer',
                  binding,
                  { factory }
                )
                bases.push(base)
                clients.push(await ProtectedOperationStateStore.open(base, makeCodec(), options))
              }
              const client = clients[index % clients.length],
                value = { sequence: step.value, private: 'retained-original-private-marker' }
              const before = revision,
                writeRevision = String(step.stale ? Math.max(0, before - 2) : before)
              const actual = await client.compareAndSwap(writeRevision, value)
              if (step.stale)
                expect(actual).toEqual({ status: 'conflict', revision: String(before) })
              else {
                revision++
                expected = value
                expect(actual).toEqual({ status: 'updated', revision: String(revision) })
              }
              if (step.replay && !step.stale)
                expect(await clients[0].compareAndSwap(String(before), value)).toEqual({
                  status: 'replayed',
                  revision: String(revision)
                })
              for (const owner of clients)
                expect(await owner.read()).toEqual({ revision: String(revision), value: expected })
              const raw = canonicalOutputJSON((await first.read()).value)
              expect(raw).not.toContain('retained-original-private-marker')
              expect(raw).not.toContain('sequence')
            }
          } finally {
            await Promise.all(bases.map(base => base.close()))
          }
        }
      )
    )
  },
  Math.max(
    30000,
    (Number.isSafeInteger(runs) ? Math.max(MIN_PROPERTY_RUNS, runs) : MIN_PROPERTY_RUNS) * 150
  )
)
