import { createHash } from 'node:crypto'
import { getOverlayAdmissionHost } from '../../EngineAdmission.js'
import { MongoOverlayStorage } from '../../storage/mongo/MongoOverlayStorage.js'
import { bootstrapMongoOverlay } from '../../storage/mongo/MongoSchema.js'
import { createMongoReplicaFixture, type MongoReplicaFixture } from './MongoReplicaFixture.js'

describe('MongoOverlayStorage as the Engine admission host', () => {
  let fixture: MongoReplicaFixture
  let storage: MongoOverlayStorage

  beforeAll(async () => {
    fixture = await createMongoReplicaFixture()
    await bootstrapMongoOverlay(fixture.db, fixture.scope)
    storage = new MongoOverlayStorage(fixture.db, fixture.scope)
  }, 120000)

  afterAll(async () => {
    await fixture.close()
  }, 60000)

  test('publishes a payload through the host object the Engine uses', async () => {
    const host = getOverlayAdmissionHost(storage)
    expect(host?.publishAdmissionPayload).toBeDefined()
    const bytes = Uint8Array.of(9, 8, 7, 6)
    const ref = await host?.publishAdmissionPayload?.({ kind: 'locking-script', bytes })
    expect(ref).toMatchObject({
      kind: 'locking-script',
      digest: createHash('sha256').update(bytes).digest('hex'),
      byteLength: '4'
    })
  }, 30000)

  test('reads the history fence through the host object', async () => {
    const host = getOverlayAdmissionHost(storage)
    const fence = await host?.getHistoryFence?.('tm_host_binding')
    expect(fence).toEqual(await storage.getHistoryFence('tm_host_binding'))
  }, 30000)
})
