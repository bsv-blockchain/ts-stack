import { expect, test } from '@jest/globals'
import fc from 'fast-check'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecretKey } from 'node:crypto'
import { PrivateKey } from '@bsv/sdk'
import { SQLiteProtectedOperationObjectStore } from '../src/operations/SQLiteProtectedOperationObjectStore.js'
import { NodeProtectedPayloadCodec } from '../src/private/NodeProtectedPayloadCodec.js'
import { IDBFactory } from 'fake-indexeddb'
import { IndexedDBProtectedOperationObjectStore } from '../src/operations/IndexedDBProtectedOperationObjectStore.js'
import { custody } from './protected-operation-object.fixture.js'
const MIN_PROPERTY_RUNS = 300
const runs = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10),
  seed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10),
  replay = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(runs) ? Math.max(MIN_PROPERTY_RUNS, runs) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(seed) ? { seed } : {}),
  ...(replay ? { path: replay } : {})
})

test('generated native result histories retain the original immutable bytes across retries, reopen and capacity conflicts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'result-property-'))
  const configuration = {
    storeId: '89'.repeat(32),
    recipient: new PrivateKey(85).toPublicKey().toString(),
    binding: { purpose: 'generated-recipient' },
    maximumObjects: 1,
    maximumObjectBytes: 128
  }
  const codec = new NodeProtectedPayloadCodec(
    { resolve: () => createSecretKey(Buffer.alloc(32, 85)) },
    'fixture-key'
  )
  const file = join(directory, 'recipient.sqlite'),
    id = '86'.repeat(32),
    binding = { request: 'original' }
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ maxLength: 128 }),
        fc.array(fc.constantFrom('read', 'retry', 'reopen', 'compete', 'capacity'), {
          minLength: 1,
          maxLength: 8
        }),
        async (bytes, history) => {
          let store = SQLiteProtectedOperationObjectStore.create(file, configuration, codec)
          try {
            expect(await store.read(id, binding)).toEqual({ state: 'absent' })
            const reservation = await store.reserve(id, binding, 128)
            expect(await store.read(id, binding)).toEqual({ state: 'reserved', reservation })
            const receipt = await store.put(id, binding, bytes)
            for (const step of history) {
              if (step === 'reopen') {
                await store.close()
                store = SQLiteProtectedOperationObjectStore.open(file, configuration, codec)
              }
              if (step === 'retry') expect(await store.put(id, binding, bytes)).toEqual(receipt)
              if (step === 'capacity')
                await expect(store.reserve('88'.repeat(32), binding, 1)).rejects.toMatchObject({
                  code: 'limited'
                })
              if (step === 'compete') {
                const changed =
                  bytes.length === 0
                    ? new Uint8Array([1])
                    : Uint8Array.from(bytes, (byte, index) => (index === 0 ? byte ^ 1 : byte))
                await expect(store.put(id, binding, changed)).rejects.toMatchObject({
                  code: 'conflict'
                })
              }
              expect(await store.read(id, binding)).toEqual({ state: 'stored', receipt, bytes })
            }
          } finally {
            await store.close()
            for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true })
          }
        }
      )
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 120000)

test('generated browser object histories preserve first bytes, original roles and capacities across reopened connections', async () => {
  const configuration = {
    storeId: '89'.repeat(32),
    recipient: new PrivateKey(85).toPublicKey().toString(),
    binding: { purpose: 'generated-browser-recipient' },
    maximumObjects: 1,
    maximumObjectBytes: 128
  }
  const id = '86'.repeat(32),
    binding = { role: 'original-request' }
  await fc.assert(
    fc.asyncProperty(
      fc.uint8Array({ maxLength: 128 }),
      fc.array(fc.constantFrom('read', 'retry', 'reopen', 'compete', 'capacity', 'binding'), {
        minLength: 1,
        maxLength: 8
      }),
      async (bytes, history) => {
        const factory = new IDBFactory(),
          name = 'generated-original-custody'
        let store = await IndexedDBProtectedOperationObjectStore.create(
          name,
          configuration,
          custody(),
          { factory }
        )
        try {
          expect(await store.read(id, binding)).toEqual({ state: 'absent' })
          const reservation = await store.reserve(id, binding, 128)
          expect(await store.read(id, binding)).toEqual({ state: 'reserved', reservation })
          const receipt = await store.put(id, binding, bytes)
          for (const step of history) {
            if (step === 'reopen') {
              await store.close()
              store = await IndexedDBProtectedOperationObjectStore.open(
                name,
                configuration,
                custody(),
                { factory }
              )
            }
            if (step === 'retry') expect(await store.put(id, binding, bytes)).toEqual(receipt)
            if (step === 'capacity')
              await expect(store.reserve('88'.repeat(32), binding, 1)).rejects.toMatchObject({
                code: 'limited'
              })
            if (step === 'binding')
              await expect(store.read(id, { role: 'different-result' })).rejects.toMatchObject({
                code: 'context-changed'
              })
            if (step === 'compete') {
              const changed =
                bytes.length === 0
                  ? new Uint8Array([1])
                  : Uint8Array.from(bytes, (byte, index) => (index === 0 ? byte ^ 1 : byte))
              await expect(store.put(id, binding, changed)).rejects.toMatchObject({
                code: 'conflict'
              })
            }
            expect(await store.read(id, binding)).toEqual({ state: 'stored', receipt, bytes })
          }
        } finally {
          await store.close()
        }
      }
    )
  )
}, 120000)

test('generated joint native reads preserve ordered original custody through reopen, detached mutation and conflicting selectors', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'joint-result-property-')),
    file = join(directory, 'recipient.sqlite'),
    configuration = {
      storeId: '91'.repeat(32),
      recipient: new PrivateKey(85).toPublicKey().toString(),
      binding: { purpose: 'generated-joint-custody' },
      maximumObjects: 3,
      maximumObjectBytes: 128
    },
    codec = new NodeProtectedPayloadCodec(
      { resolve: () => createSecretKey(Buffer.alloc(32, 85)) },
      'fixture-key'
    ),
    first = { id: '92'.repeat(32), originalBinding: { role: 'first' } },
    second = { id: '93'.repeat(32), originalBinding: { role: 'second' } },
    absent = { id: '94'.repeat(32), originalBinding: { role: 'absent' } }
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ maxLength: 128 }),
        fc.uint8Array({ maxLength: 128 }),
        fc.boolean(),
        fc.array(fc.constantFrom('read', 'reopen', 'mutate', 'binding', 'duplicate'), {
          minLength: 1,
          maxLength: 8
        }),
        async (firstBytes, secondBytes, reverse, history) => {
          let store = SQLiteProtectedOperationObjectStore.create(file, configuration, codec)
          try {
            const firstReservation = await store.reserve(first.id, first.originalBinding, 128),
              secondReservation = await store.reserve(second.id, second.originalBinding, 128)
            expect(await store.readMany([second, absent, first])).toEqual([
              { state: 'reserved', reservation: secondReservation },
              { state: 'absent' },
              { state: 'reserved', reservation: firstReservation }
            ])
            const firstReceipt = await store.put(first.id, first.originalBinding, firstBytes),
              secondReceipt = await store.put(second.id, second.originalBinding, secondBytes),
              selectors = reverse ? [second, absent, first] : [first, absent, second],
              expected = reverse
                ? [
                    { state: 'stored', receipt: secondReceipt, bytes: secondBytes },
                    { state: 'absent' },
                    { state: 'stored', receipt: firstReceipt, bytes: firstBytes }
                  ]
                : [
                    { state: 'stored', receipt: firstReceipt, bytes: firstBytes },
                    { state: 'absent' },
                    { state: 'stored', receipt: secondReceipt, bytes: secondBytes }
                  ]
            for (const step of history) {
              if (step === 'reopen') {
                await store.close()
                store = SQLiteProtectedOperationObjectStore.open(file, configuration, codec)
              }
              if (step === 'binding')
                await expect(
                  store.readMany([first, { ...second, originalBinding: { role: 'changed' } }])
                ).rejects.toMatchObject({ code: 'context-changed' })
              if (step === 'duplicate')
                await expect(store.readMany([first, first])).rejects.toThrow('Duplicate')
              const values = await store.readMany(selectors)
              expect(values).toEqual(expected)
              for (const value of values) {
                if (value.state !== 'stored') continue
                if (step === 'mutate') value.receipt.maximumBytes = 1
                value.bytes.fill(0)
              }
              const retained = await store.readMany(selectors)
              expect(retained).toEqual(expected)
              for (const value of retained) if (value.state === 'stored') value.bytes.fill(0)
            }
            // Status reads cannot consume a slot or initialize the absent role.
            expect(await store.read(absent.id, absent.originalBinding)).toEqual({ state: 'absent' })
          } finally {
            await store.close()
            for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true })
          }
        }
      ),
      { interruptAfterTimeLimit: 150000, markInterruptAsFailure: true }
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 180000)
