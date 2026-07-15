import { SHIPStorage } from '../SHIP/SHIPStorage.js'
import { SLAPStorage } from '../SLAP/SLAPStorage.js'

describe('discovery storage', () => {
  it('upserts the latest SHIP advertisement for a provider and topic', async () => {
    const updateOne = jest.fn().mockResolvedValue({ acknowledged: true })
    const db = { collection: jest.fn().mockReturnValue({ updateOne }) } as any
    const storage = new SHIPStorage(db)

    await storage.storeSHIPRecord('new-txid', 2, 'identity', 'https://host.example', 'tm_music')

    expect(updateOne).toHaveBeenCalledWith(
      { identityKey: 'identity', domain: 'https://host.example', topic: 'tm_music' },
      {
        $set: expect.objectContaining({
          txid: 'new-txid',
          outputIndex: 2,
          identityKey: 'identity',
          domain: 'https://host.example',
          topic: 'tm_music'
        })
      },
      { upsert: true }
    )
  })

  it('upserts the latest SLAP advertisement for a provider and service', async () => {
    const updateOne = jest.fn().mockResolvedValue({ acknowledged: true })
    const db = { collection: jest.fn().mockReturnValue({ updateOne }) } as any
    const storage = new SLAPStorage(db)

    await storage.storeSLAPRecord('new-txid', 3, 'identity', 'https://host.example', 'ls_music')

    expect(updateOne).toHaveBeenCalledWith(
      { identityKey: 'identity', domain: 'https://host.example', service: 'ls_music' },
      {
        $set: expect.objectContaining({
          txid: 'new-txid',
          outputIndex: 3,
          identityKey: 'identity',
          domain: 'https://host.example',
          service: 'ls_music'
        })
      },
      { upsert: true }
    )
  })
})
