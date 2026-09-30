import { KnexSnapshotArchiveRpc } from './KnexSnapshotArchiveRpc'
import { snapshotArchiveCapabilities } from './SnapshotArchiveProtocol'
import { StorageKnex } from '../../StorageKnex'
import { gate, snapshotHttpFixture } from '../../../../test/utils/snapshotArchiveHttpFixtures'

afterEach(() => jest.restoreAllMocks())

test.each(['snapshot_archive_requests', 'snapshot_archives', 'snapshot_archive_pages', 'snapshot_archive_capacity'])(
  'declines capability when migration table %s is missing',
  async table => {
    const fixture = await snapshotHttpFixture()
    const rpc = new KnexSnapshotArchiveRpc(fixture.storage)
    try {
      expect(await rpc.capabilities()).toEqual(snapshotArchiveCapabilities)
      await fixture.storage.knex.schema.dropTable(table)
      expect(await rpc.capabilities()).toBeUndefined()
      await expect(
        rpc.dispatch('getSnapshotArchiveOffer', [{ version: 1, identityKey: fixture.identityKey }], fixture.identityKey)
      ).rejects.toThrow('unavailable')
    } finally {
      await rpc.close()
      await fixture.close()
    }
  }
)

test('unsupported source and a close during capability probing never advertise or open a pool', async () => {
  const fixture = await snapshotHttpFixture()
  const rpc = new KnexSnapshotArchiveRpc(fixture.storage)
  try {
    const open = jest.spyOn(fixture.storage, 'openSnapshotArchiveSource')
    const supported = jest.spyOn(fixture.storage, 'supportsSnapshotArchiveSource').mockResolvedValue(false)
    expect(await rpc.capabilities()).toBeUndefined()
    const entered = gate()
    const resume = gate()
    supported.mockImplementation(async () => {
      entered.resolve()
      await resume.promise
      return true
    })
    const pending = rpc.capabilities()
    await entered.promise
    await rpc.close()
    resume.resolve()
    expect(await pending).toBeUndefined()
    expect(await rpc.capabilities()).toBeUndefined()
    expect(open).not.toHaveBeenCalled()
  } finally {
    await rpc.close()
    await fixture.close()
  }
})

test('unsupported chain is declined and remains checked before an offer', async () => {
  const storage = { chain: 'mock', knex: {} } as unknown as StorageKnex
  const rpc = new KnexSnapshotArchiveRpc(storage)
  expect(await rpc.capabilities()).toBeUndefined()
  jest.spyOn(rpc, 'capabilities').mockResolvedValue(snapshotArchiveCapabilities)
  const identityKey = '02' + '11'.repeat(32)
  await expect(rpc.dispatch('getSnapshotArchiveOffer', [{ version: 1, identityKey }], identityKey)).rejects.toThrow(
    'chain is unavailable'
  )
  await rpc.close()
})

test('main-chain sources negotiate and return a main-chain offer without opening a capture', async () => {
  const fixture = await snapshotHttpFixture()
  Reflect.set(fixture.storage, 'chain', 'main')
  const rpc = new KnexSnapshotArchiveRpc(fixture.storage)
  try {
    const open = jest.spyOn(fixture.storage, 'openSnapshotArchiveSource')
    expect(await rpc.capabilities()).toEqual(snapshotArchiveCapabilities)
    expect(
      await rpc.dispatch(
        'getSnapshotArchiveOffer',
        [{ version: 1, identityKey: fixture.identityKey }],
        fixture.identityKey
      )
    ).toMatchObject({ chain: 'main', sourceStorageIdentityKey: 'http-snapshot-source' })
    expect(open).not.toHaveBeenCalled()
  } finally {
    await rpc.close()
    await fixture.close()
  }
})
