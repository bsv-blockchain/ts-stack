import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import WalletClient from '../WalletClient'
import WalletWireTransceiver from '../substrates/WalletWireTransceiver'
import HTTPWalletJSON from '../substrates/HTTPWalletJSON'

describe('WalletClient automatic HTTP discovery', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => jest.restoreAllMocks())

  const brc205Version =
    'wallet-brc100-1.0.0; brc207-color=4; brc207-color-attested=1; brc177-nosend=2;'

  it.each([
    ['wire', 'http://localhost:3301', '1.0.0.0'],
    ['json', 'http://localhost:3321', '1.0.0.0'],
    ['secure-json', 'https://localhost:2121', '1.0.0.0'],
    ['wire', 'http://localhost:3301', brc205Version],
    ['json', 'http://localhost:3321', brc205Version]
  ])(
    'preserves an explicit caller through %s discovery at %s and later calls (version %s)',
    async (kind, endpoint, version) => {
      const requests: Array<{ path: string; origin: string | undefined }> = []
      const server = createServer((request, response) => {
        requests.push({ path: request.url!, origin: request.headers.origin })
        request.resume()
        response.setHeader(
          'Content-Type',
          kind === 'wire' ? 'application/octet-stream' : 'application/json'
        )
        response.end(
          kind === 'wire'
            ? Buffer.concat([Buffer.from([0]), Buffer.from(version)])
            : JSON.stringify({ version })
        )
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const address = server.address() as AddressInfo
      // Use real HTTP without occupying a developer's installed wallet ports.
      jest.spyOn(globalThis, 'fetch').mockImplementation(async function (
        this: unknown,
        input,
        init
      ) {
        // Browser fetch enforces its receiver even though Node's fetch does not.
        if (this !== globalThis) throw new TypeError('Illegal invocation')
        const url = new URL(String(input))
        if (url.origin !== endpoint) throw new Error('This wallet transport is unavailable')
        return await originalFetch(`http://127.0.0.1:${address.port}${url.pathname}`, init)
      })
      try {
        const client = new WalletClient('auto', 'app.example')
        await expect(client.getVersion()).resolves.toEqual({ version })
        expect(client.substrate).toBeInstanceOf(
          kind === 'wire' ? WalletWireTransceiver : HTTPWalletJSON
        )
        await expect(client.getVersion()).resolves.toEqual({ version })
        expect(requests).toEqual(
          Array.from({ length: 3 }, () => ({
            path: '/getVersion',
            origin: kind === 'wire' ? 'app.example' : 'http://app.example'
          }))
        )
      } finally {
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) =>
          server.close(error => (error ? reject(error) : resolve()))
        )
      }
    }
  )
})
