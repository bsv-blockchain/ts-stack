import { LiveIngestorTeranodeP2P } from '../LiveIngestorTeranodeP2P'

describe('LiveIngestorTeranodeP2P', () => {
  test('keeps the current inert listener contract', async () => {
    const options = LiveIngestorTeranodeP2P.createLiveIngestorTeranodeP2POptions('main')
    const ingestor = new LiveIngestorTeranodeP2P(options)
    const log = jest.fn()
    ingestor.log = log

    await expect(ingestor.getHeaderByHash('ab'.repeat(32))).resolves.toBeUndefined()
    await expect(ingestor.startListening([])).resolves.toBeUndefined()
    expect(() => ingestor.stopListening()).not.toThrow()
    expect(log).not.toHaveBeenCalled()
  })
})
