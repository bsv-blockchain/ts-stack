import { BHServiceClient } from '../BHServiceClient'
import { ChaintracksServiceClient } from '../chaintracks/ChaintracksServiceClient'
import { GoChaintracksServiceClient } from '../chaintracks/GoChaintracksServiceClient'

// Browsers refuse fetch unless it is called on the window (or with no
// receiver): Chrome reports "Illegal invocation", WebKit "Can only call
// Window.fetch on instances of Window". Node's fetch does not check, so these
// tests stand in a fetch that does.
function browserFetch(body: unknown, status = 200): typeof fetch {
  return function (this: unknown) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation")
    }
    return Promise.resolve(
      new Response(status === 404 ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
      })
    )
  } as unknown as typeof fetch
}

const realFetch = global.fetch
afterEach(() => {
  global.fetch = realFetch
})

describe('chain-tracker clients call fetch the way browsers require', () => {
  test('ChaintracksServiceClient with a supplied fetch', async () => {
    const client = new ChaintracksServiceClient('main', 'https://chaintracks.example', {
      ...ChaintracksServiceClient.createChaintracksServiceClientOptions(),
      fetch: browserFetch({ status: 'success' })
    })
    await expect(client.findHeaderForHeight(5)).resolves.toBeUndefined()
  })

  test('ChaintracksServiceClient with the global fetch', async () => {
    global.fetch = browserFetch({ status: 'success' })
    const client = new ChaintracksServiceClient('main', 'https://chaintracks.example')
    await expect(client.findHeaderForHeight(5)).resolves.toBeUndefined()
  })

  test('BHServiceClient with a supplied fetch', async () => {
    const client = new BHServiceClient('main', 'https://headers.example', 'key', { fetch: browserFetch(null, 404) })
    await expect(client.findHeaderForHeight(5)).resolves.toBeUndefined()
  })

  test('BHServiceClient with the global fetch', async () => {
    global.fetch = browserFetch(null, 404)
    const client = new BHServiceClient('main', 'https://headers.example', 'key')
    await expect(client.findHeaderForHeight(5)).resolves.toBeUndefined()
  })

  test('GoChaintracksServiceClient with a supplied fetch', async () => {
    const client = new GoChaintracksServiceClient('main', 'https://chaintracks.example/v2', {
      fetch: browserFetch(7)
    })
    await expect(client.getPresentHeight()).resolves.toBe(7)
  })

  test('GoChaintracksServiceClient with the global fetch', async () => {
    global.fetch = browserFetch(7)
    const client = new GoChaintracksServiceClient('main', 'https://chaintracks.example/v2')
    await expect(client.getPresentHeight()).resolves.toBe(7)
  })

  test('ChaintracksServiceClient refuses a fetch that is not a function', () => {
    expect(
      () =>
        new ChaintracksServiceClient('main', 'https://chaintracks.example', {
          ...ChaintracksServiceClient.createChaintracksServiceClientOptions(),
          fetch: 1 as unknown as typeof fetch
        })
    ).toThrow('fetch must be a function')
  })
})
