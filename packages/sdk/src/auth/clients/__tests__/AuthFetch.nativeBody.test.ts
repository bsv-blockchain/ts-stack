import { jest } from '@jest/globals'
import { AuthFetch } from '../AuthFetch.js'

const url = 'https://service.example/form'

function setup(cached: boolean) {
  let request: Request
  const fetchClient = jest.fn<typeof fetch>(async (input, init) => {
    request = new Request(input, init)
    return new Response('ok')
  })
  const client = new AuthFetch({} as never, undefined, undefined, undefined, {}, fetchClient)
  const peer = {
    listenForGeneralMessages: jest.fn(() => 1),
    stopListeningForGeneralMessages: jest.fn(),
    toPeer: jest.fn(async () => {
      throw new Error('HTTP server failed to authenticate')
    })
  }
  client.peers[new URL(url).origin] = {
    peer: peer as never,
    supportsMutualAuth: cached ? false : undefined,
    pendingCertificateRequests: []
  }
  return { client, fetchClient, request: () => request!, peer }
}

describe.each([true, false])('ordinary HTTP native bodies (cached=%s)', cached => {
  test.each([
    [
      'URLSearchParams',
      () => new URLSearchParams([['name', '雪 & space']]),
      'application/x-www-form-urlencoded;charset=UTF-8',
      'name=%E9%9B%AA+%26+space'
    ],
    [
      'typed Blob',
      () => new Blob(['{"name":"雪"}'], { type: 'application/json' }),
      'application/json',
      '{"name":"雪"}'
    ],
    ['text', () => '雪 & space', 'text/plain;charset=UTF-8', '雪 & space']
  ])(
    'retains native %s serialization and inferred content type',
    async (_name, body, type, text) => {
      const fixture = setup(cached)
      await fixture.client.fetch(url, { method: 'POST', body: body() })
      expect(fixture.request().headers.get('content-type')).toBe(type)
      await expect(fixture.request().text()).resolves.toBe(text)
      expect(fixture.request().redirect).toBe('error')
      expect(fixture.peer.toPeer).toHaveBeenCalledTimes(cached ? 0 : 1)
      expect(fixture.client.peers[new URL(url).origin].supportsMutualAuth).toBe(false)
    }
  )

  test('retains multipart fields and snapshots FormData before awaiting discovery', async () => {
    const fixture = setup(cached)
    const body = new FormData()
    body.append('name', '雪 & space')
    body.append('name', 'second')
    const pending = fixture.client.fetch(url, { method: 'POST', body })
    body.set('name', 'changed')
    await pending
    expect(fixture.request().headers.get('content-type')).toMatch(
      /^multipart\/form-data; boundary=/
    )
    const received = await fixture.request().formData()
    expect(received.getAll('name')).toEqual(['雪 & space', 'second'])
  })

  test('snapshots URLSearchParams while preserving explicit content type', async () => {
    const fixture = setup(cached)
    const body = new URLSearchParams({ name: 'original' })
    const headers = { 'Content-Type': 'application/custom' }
    const pending = fixture.client.fetch(url, { method: 'POST', headers, body })
    body.set('name', 'changed')
    headers['Content-Type'] = 'changed'
    await pending
    expect(fixture.request().headers.get('content-type')).toBe('application/custom')
    await expect(fixture.request().text()).resolves.toBe('name=original')
  })

  test('retains owned bytes for a mutable array-buffer view', async () => {
    const fixture = setup(cached)
    const buffer = Uint8Array.of(0, 1, 2, 3)
    const body = buffer.subarray(1, 3)
    const pending = fixture.client.fetch(url, { method: 'POST', body })
    buffer.fill(9)
    await pending
    expect(fixture.request().headers.has('content-type')).toBe(false)
    await expect(fixture.request().arrayBuffer()).resolves.toEqual(Uint8Array.of(1, 2).buffer)
  })

  test('snapshots numeric byte arrays before its first await', async () => {
    const fixture = setup(cached)
    const body = [1, 2]
    const pending = fixture.client.fetch(url, { method: 'POST', body })
    body.fill(9)
    await pending
    await expect(fixture.request().arrayBuffer()).resolves.toEqual(Uint8Array.of(1, 2).buffer)
  })
})
