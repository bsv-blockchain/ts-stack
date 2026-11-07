import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { outputPacketDigest } from '@bsv/sdk'
import { SQLiteLookupIndex } from '../src/lookup/SQLiteLookupIndex.js'
import { SQLiteLookupSessions } from '../src/lookup/SQLiteLookupSessions.js'
import { SQLiteLookupSessionRecords } from '../src/lookup/SQLiteLookupSessionRecords.js'
import { sessionConfiguration } from '../src/lookup/SQLiteLookupSessionSchema.js'
import { sqliteLookupBridge } from '../src/lookup/SQLiteLookupBridge.js'
import { LookupSessionCodec } from '../src/lookup/LookupSessionCodec.js'
import { lookupSessionFixture } from './lookup-session-fixture.js'
import { liveFixture } from './live-lookup-fixture.js'

it('retains every original query and first response as one record and rolls back all record parts together', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lookup-record-property-'))
  const index = SQLiteLookupIndex.create(join(directory, 'records.db'), 'records', {
    profile: 'record-test'
  })
  try {
    const codec = new LookupSessionCodec(liveFixture().selection)
    const sessions = SQLiteLookupSessions.create(index, codec, () => '1000')
    const epoch = await sessions.createEpoch()
    const { value } = lookupSessionFixture('none', epoch, '0')
    const bridge = index[sqliteLookupBridge]()
    const records = new SQLiteLookupSessionRecords(
      bridge,
      codec,
      sessionConfiguration(sessions.capacity),
      sessions.capacity
    )
    const retainedEpoch = records.epoch(epoch)
    const rollback = new Error('test-owned transaction rollback')
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 8, maxLength: 64 }),
        fc.string({ maxLength: 128 }),
        async (identifier, collection) => {
          const candidate = structuredClone(value)
          candidate.open.requestId = Buffer.from(identifier).toString('hex')
          candidate.open.query = { collection: collection || 'records' }
          candidate.first.scope.queryDigest = outputPacketDigest('lookup-query', {
            service: candidate.open.service,
            query: candidate.open.query
          })
          const original = {
            epoch,
            principal: null,
            open: candidate.open,
            manifestDigest: outputPacketDigest('capabilities', candidate.contract.manifest.body)
          }
          const openingKey = records.openingKey(retainedEpoch, original)
          expect(() =>
            bridge.transaction(() => {
              records.saveOpening(retainedEpoch, candidate)
              const fence = records.fence(retainedEpoch, openingKey)!
              expect(records.opening(retainedEpoch, fence)).toEqual(candidate)
              expect(records.bySession(candidate.session)).toEqual({ epoch: retainedEpoch, fence })
              expect(records.metadata()).toMatchObject({ fences: 1, sessions: 1 })
              throw rollback
            })
          ).toThrow(rollback)
          expect(records.fence(retainedEpoch, openingKey)).toBeNull()
          expect(records.bySession(candidate.session)).toBeNull()
          expect(records.metadata()).toMatchObject({ fences: 0, sessions: 0, bytes: 0 })
          records.verifyInventory()
        }
      ),
      {}
    )
  } finally {
    await index.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 600000)

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})
