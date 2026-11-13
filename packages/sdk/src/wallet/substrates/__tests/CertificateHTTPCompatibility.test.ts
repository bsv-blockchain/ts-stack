import { createServer } from 'node:http'
import { once } from 'node:events'
import historicalVectors from '../../../../../../specs/wallet/fixtures/legacy-certificates.json'
import HTTPWalletWire from '../HTTPWalletWire'
import WalletWireTransceiver from '../WalletWireTransceiver'
import WalletWireProcessor from '../WalletWireProcessor'
import WalletWireCalls from '../WalletWireCalls'
import type { WalletInterface } from '../../Wallet.interfaces'
import { toArray } from '../../../primitives/utils'

const canonical = historicalVectors.vectors.find(c => c.length === 32)!.certificate
const legacy = historicalVectors.vectors.find(c => c.length === 31)!.certificate
const origin = 'peercert.example'

function setup(status?: number) {
  const list = jest.fn(async () => ({ totalCertificates: 1, certificates: [{ ...canonical }] }))
  const relinquish = jest.fn(async () => ({ relinquished: true as const }))
  const processor = new WalletWireProcessor({
    listCertificates: list,
    relinquishCertificate: relinquish
  } as unknown as WalletInterface)
  const routes: string[] = []
  const fetcher: typeof fetch = async (url, options) => {
    const route = new URL(String(url)).pathname.slice(1)
    routes.push(route)
    if (route === 'certificateCompatibility' && status !== undefined) {
      return new Response(null, { status })
    }
    const code =
      route === 'certificateCompatibility'
        ? 29
        : WalletWireCalls[route as keyof typeof WalletWireCalls]
    const bytes = toArray(origin, 'utf8')
    const result = await processor.transmitToWalletUint8Array(
      Uint8Array.from([code, bytes.length, ...bytes, ...(options!.body as Uint8Array)])
    )
    return new Response(result as BodyInit)
  }
  const client = new WalletWireTransceiver(
    new HTTPWalletWire(origin, 'https://wallet.example', fetcher)
  )
  return { client, list, relinquish, routes, fetcher }
}

test.each([404, 405])(
  'old HTTP router %i preserves canonical listing and rejects legacy mutation before dispatch',
  async status => {
    const { client, list, relinquish, routes } = setup(status)
    expect(
      (await client.listCertificates({ types: [], certifiers: [] }, origin)).certificates[0].type
    ).toBe(canonical.type)
    expect(routes).toEqual(['certificateCompatibility', 'listCertificates'])
    expect(list).toHaveBeenCalledTimes(1)
    await expect(
      client.relinquishCertificate(
        { type: legacy.type, serialNumber: legacy.serialNumber, certifier: legacy.certifier },
        origin
      )
    ).rejects.toThrow(/does not support legacy/)
    expect(relinquish).not.toHaveBeenCalled()
    expect(routes).toHaveLength(2)
  }
)

test.each([400, 401, 403, 408, 429, 500, 502])(
  'HTTP %i during negotiation never silently downgrades',
  async status => {
    const { client, list, routes } = setup(status)
    await expect(client.listCertificates({ types: [], certifiers: [] }, origin)).rejects.toThrow(
      /HTTP status/
    )
    expect(list).not.toHaveBeenCalled()
    expect(routes).toEqual(['certificateCompatibility'])
  }
)

test('a missing invocation route never retries the mutation', async () => {
  const { fetcher, relinquish } = setup()
  let requests = 0
  const client = new WalletWireTransceiver(
    new HTTPWalletWire(origin, 'https://wallet.example', async (url, options) => {
      requests++
      return requests === 1 ? await fetcher(url, options) : new Response(null, { status: 404 })
    })
  )
  await expect(
    client.relinquishCertificate(
      { type: legacy.type, serialNumber: legacy.serialNumber, certifier: legacy.certifier },
      origin
    )
  ).rejects.toThrow(/HTTP status 404/)
  expect(requests).toBe(2)
  expect(relinquish).not.toHaveBeenCalled()
})

test('binary HTTP profile round-trips an independently signed legacy certificate over a real socket', async () => {
  const list = jest.fn(async () => ({ totalCertificates: 1, certificates: [{ ...legacy }] }))
  const processor = new WalletWireProcessor({
    listCertificates: list
  } as unknown as WalletInterface)
  const routes: string[] = []
  const server = createServer(async (request, response) => {
    try {
      routes.push(request.url!)
      const code = request.url === '/certificateCompatibility' ? 29 : 18
      const originBytes = toArray(String(request.headers.origin), 'utf8')
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const bytes = Uint8Array.from([
        code,
        originBytes.length,
        ...originBytes,
        ...Buffer.concat(chunks)
      ])
      const result = await processor.transmitToWalletUint8Array(bytes)
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(result)
    } catch {
      response.writeHead(500).end()
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const address = server.address() as { port: number }
    const client = new WalletWireTransceiver(
      new HTTPWalletWire(origin, `http://127.0.0.1:${address.port}`)
    )
    const result = await client.listCertificates({ types: [], certifiers: [] }, origin)
    expect(result.certificates[0]).toMatchObject(legacy)
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ types: [] }), origin)
    expect(list).toHaveBeenCalledTimes(1)
    expect(routes).toEqual(['/certificateCompatibility', '/certificateCompatibility'])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    )
  }
})

test.each([
  [0, 2],
  [0, 1, 0],
  [1, 1, 20]
])(
  'HTTP 404 for non-probe payload %j is not an unsupported-capability signal',
  async (...payload: number[]) => {
    const wire = new HTTPWalletWire(
      undefined,
      'https://wallet.example',
      async () => new Response(null, { status: 404 })
    )
    await expect(wire.transmitToWallet([29, 0, ...payload])).rejects.toThrow(/HTTP status 404/)
  }
)
