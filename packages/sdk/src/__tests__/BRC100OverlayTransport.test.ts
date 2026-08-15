import { HTTPSOverlayLookupFacilitator } from '../overlay-tools/LookupResolver'

describe('overlay lookup BRC-100 byte compatibility', () => {
  it('keeps typed query bytes portable across the JSON request boundary', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ type: 'output-list', outputs: [] })
    })
    const facilitator = new HTTPSOverlayLookupFacilitator(mockFetch, true)

    await facilitator.lookup('http://host', {
      service: 'ls_test',
      query: { payload: new Uint8Array([1, 2, 255]) }
    })

    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
      service: 'ls_test',
      query: { payload: [1, 2, 255] }
    })
  })

  it('recovers historical numeric-key BEEF from a JSON response', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({
        type: 'output-list',
        outputs: [{ beef: { 0: 1, 1: 2, 2: 255 }, outputIndex: 0 }]
      })
    })
    const facilitator = new HTTPSOverlayLookupFacilitator(mockFetch, true)

    await expect(
      facilitator.lookup('http://host', { service: 'ls_test', query: {} })
    ).resolves.toEqual({
      type: 'output-list',
      outputs: [{ beef: [1, 2, 255], outputIndex: 0 }]
    })
  })
})
