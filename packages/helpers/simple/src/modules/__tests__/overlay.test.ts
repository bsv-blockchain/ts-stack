import { Overlay } from '../overlay'

describe('Overlay', () => {
  it('accepts the TerraTestNet overlay preset', async () => {
    const overlay = await Overlay.create({
      topics: ['tm_example'],
      network: 'teratestnet'
    })

    expect(overlay.getInfo()).toEqual({
      topics: ['tm_example'],
      network: 'teratestnet'
    })
  })
})
