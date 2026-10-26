import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import HttpClient from '../httpClient.js'

describe('HttpClient Node transport', () => {
  it('uses the pinned resolver through the real HTTP agent', async () => {
    const server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json')
      response.end('{"ok":true}')
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })

    try {
      const address = server.address() as AddressInfo
      const resolver = jest.fn(async () => [{ address: '127.0.0.1', family: 4 }])
      const client = new HttpClient(1000, { addressResolver: resolver })

      const response = await client.request(`http://localhost:${address.port}`)

      await expect(response.json()).resolves.toEqual({ ok: true })
      expect(resolver).toHaveBeenCalledWith('localhost')
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error == null ? resolve() : reject(error)))
      })
    }
  })
})
