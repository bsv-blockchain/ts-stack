import { AuthFetch, PrivateKey, ProtoWallet } from '@bsv/sdk'
import { StorageClient } from '../../remoting/StorageClient'
import { BINARY_ENCODING, BINARY_ENCODING_HEADER } from '../../remoting/BinaryJson'
import {
  snapshotArchiveCapabilities,
  snapshotArchiveRequestBytes,
  snapshotArchiveResponseBytes
} from './SnapshotArchiveProtocol'
import { snapshotHttpFixture } from '../../../../test/utils/snapshotArchiveHttpFixtures'

afterEach(() => jest.restoreAllMocks())

test('server requires bounded compact framing and refuses its own oversized snapshot result', async () => {
  const fixture = await snapshotHttpFixture()
  try {
    const { server, url } = await fixture.serve()
    const auth = new AuthFetch(fixture.wallet)
    for (const [binary, id, padding] of [
      [false, 1, ''],
      [true, 0, ''],
      [true, '1', ''],
      [true, 1, 'x'.repeat(snapshotArchiveRequestBytes)]
    ] as const) {
      const response = await auth.fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(binary ? { [BINARY_ENCODING_HEADER]: BINARY_ENCODING } : {})
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'getSnapshotArchiveOffer',
          params: [{ version: 1, identityKey: fixture.identityKey }],
          id,
          padding
        })
      })
      const json = await response.json()
      expect(json.error.message).toContain('bounded compact-binary RPC framing')
    }
    const client = new StorageClient(fixture.wallet, url)
    const transport = (await client.getSnapshotArchiveTransport(fixture.identityKey))!
    const rpc = Reflect.get(server, 'snapshotArchives')
    jest.spyOn(rpc, 'dispatch').mockResolvedValue({ padding: 'x'.repeat(snapshotArchiveResponseBytes) })
    await expect(transport.offer()).rejects.toThrow('response exceeds its transport limit')
  } finally {
    await fixture.close()
  }
})

test('dedicated snapshot response cap is enforced before JSON parsing over authenticated HTTP', async () => {
  const fixture = await snapshotHttpFixture()
  try {
    const { server, url } = await fixture.serve()
    const client = new StorageClient(fixture.wallet, url)
    const transport = (await client.getSnapshotArchiveTransport(fixture.identityKey))!
    const send = Reflect.get(server, 'sendRpc').bind(server)
    // An authenticated peer can be a different implementation: bypass only
    // this fixture's snapshot-specific response bound, retaining real signing.
    jest.spyOn(server as never, 'sendRpc' as never).mockImplementation(((
      res: unknown,
      binary: boolean,
      payload: { id: unknown; result: unknown }
    ) => {
      const large = {
        jsonrpc: '2.0',
        id: payload.id,
        result: { padding: 'x'.repeat(snapshotArchiveResponseBytes + 1) }
      }
      return send(res, binary, large)
    }) as never)
    await expect(transport.offer()).rejects.toThrow(/limit|large|size|exceed/i)
    const bounded = Reflect.get(client, 'snapshotAuthClient')
    expect(Reflect.get(bounded, 'maxResponseBytes')).toBe(snapshotArchiveResponseBytes)
  } finally {
    await fixture.close()
  }
})

test.each(['no-auth', 'changed-server', 'no-binary', 'wrong-id', 'non-ok'] as const)(
  'snapshot calls retain the shared authenticated response contract: %s',
  async variant => {
    const fixture = await snapshotHttpFixture()
    try {
      const { url } = await fixture.serve()
      const client = new StorageClient(fixture.wallet, url, { serverIdentityKey: fixture.serverIdentityKey })
      const transport = (await client.getSnapshotArchiveTransport(fixture.identityKey))!
      const expectedId = Reflect.get(client, 'nextId')
      const identity =
        variant === 'changed-server' ? PrivateKey.fromRandom().toPublicKey().toString() : fixture.serverIdentityKey
      const headers = {
        ...(variant === 'no-auth' ? {} : { 'x-bsv-auth-identity-key': identity }),
        ...(variant === 'no-binary' ? {} : { [BINARY_ENCODING_HEADER]: BINARY_ENCODING })
      }
      jest
        .spyOn(AuthFetch.prototype, 'fetch')
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: variant === 'wrong-id' ? expectedId + 1 : expectedId,
              result: {
                version: 1,
                serverTime: Date.now(),
                sourceStorageIdentityKey: 'http-snapshot-source',
                sourceSchema: 'schema',
                chain: 'test'
              }
            }),
            { headers, status: variant === 'non-ok' ? 503 : 200 }
          )
        )
      const reason = {
        'no-auth': /not mutually authenticated/,
        'changed-server': /identity changed/,
        'no-binary': /compact binary responses/,
        'wrong-id': /id/,
        'non-ok': /503/
      }[variant]
      await expect(transport.offer()).rejects.toThrow(reason)
    } finally {
      await fixture.close()
    }
  }
)

test('oversized snapshot envelopes reject before transport and advertised settings are privately detached', async () => {
  const fixture = await snapshotHttpFixture()
  try {
    const { url } = await fixture.serve()
    const client = new StorageClient(fixture.wallet, url)
    const settings = await client.makeAvailable()
    settings.storageIdentityKey = 'caller-mutated'
    settings.chain = 'main'
    settings.snapshotArchive = undefined
    const transport = (await client.getSnapshotArchiveTransport(fixture.identityKey))!
    expect((await transport.offer()).sourceStorageIdentityKey).toBe('http-snapshot-source')
    const fetch = jest.spyOn(AuthFetch.prototype, 'fetch')
    const call = Reflect.get(client, 'snapshotRpcCall').bind(client)
    await expect(
      call('getSnapshotArchiveOffer', [{ padding: 'x'.repeat(snapshotArchiveRequestBytes) }])
    ).rejects.toThrow('transport limit')
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    await fixture.close()
  }
})

test('legacy settings decline the capability and malformed advertisements fail rather than fall back', async () => {
  const wallet = new ProtoWallet(PrivateKey.fromRandom())
  for (const value of [undefined, null, { ...snapshotArchiveCapabilities, version: 2 }, snapshotArchiveCapabilities]) {
    const client = new StorageClient(wallet, 'http://localhost:1')
    jest.spyOn(client as never, 'rpcCall' as never).mockResolvedValue({
      storageIdentityKey: 'legacy',
      ...(value === undefined ? {} : { snapshotArchive: value })
    } as never)
    if (value !== undefined && value !== snapshotArchiveCapabilities) {
      await expect(client.makeAvailable()).rejects.toThrow()
    } else {
      expect(await client.getSnapshotArchiveTransport(PrivateKey.fromRandom().toPublicKey().toString())).toBeUndefined()
    }
  }
})

test.each([
  [4095, snapshotArchiveResponseBytes, false],
  [4096, snapshotArchiveResponseBytes, true],
  [4096, -1, true],
  [4096, snapshotArchiveResponseBytes - 1, false]
] as const)('capability respects body %p and response %p limits', async (bodyLimit, responseLimit, enabled) => {
  const fixture = await snapshotHttpFixture()
  const previous = process.env.WALLET_STORAGE_JSON_MAX_BODY_BYTES
  try {
    process.env.WALLET_STORAGE_JSON_MAX_BODY_BYTES = String(bodyLimit)
    const { url } = await fixture.serve({ maxRpcResponseBytes: responseLimit })
    const client = new StorageClient(fixture.wallet, url)
    const settings = await client.makeAvailable()
    expect(settings.snapshotArchive).toEqual(enabled ? snapshotArchiveCapabilities : undefined)
  } finally {
    if (previous === undefined) delete process.env.WALLET_STORAGE_JSON_MAX_BODY_BYTES
    else process.env.WALLET_STORAGE_JSON_MAX_BODY_BYTES = previous
    await fixture.close()
  }
})

test('main-chain client advertises a usable transport and admits an exactly bounded request', async () => {
  const key = PrivateKey.fromRandom().toPublicKey().toString()
  const client = new StorageClient(new ProtoWallet(PrivateKey.fromRandom()), 'http://localhost:1')
  jest.spyOn(client as never, 'rpcCall' as never).mockResolvedValue({
    storageIdentityKey: 'main-source',
    chain: 'main',
    snapshotArchive: snapshotArchiveCapabilities
  } as never)
  const transport = (await client.getSnapshotArchiveTransport(key))!
  const fetch = jest.spyOn(AuthFetch.prototype, 'fetch').mockImplementation(async (_url, options) => {
    const input = JSON.parse(options!.body as string)
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: input.id,
        result: {
          version: 1,
          serverTime: Date.now(),
          sourceStorageIdentityKey: 'main-source',
          sourceSchema: 'schema',
          chain: 'main'
        }
      }),
      { headers: { 'x-bsv-auth-identity-key': key, [BINARY_ENCODING_HEADER]: BINARY_ENCODING } }
    )
  })
  expect((await transport.offer()).chain).toBe('main')
  const call = Reflect.get(client, 'snapshotRpcCall').bind(client)
  const params = [{ padding: '' }]
  const base = JSON.stringify({
    jsonrpc: '2.0',
    method: 'getSnapshotArchiveOffer',
    params,
    id: Reflect.get(client, 'nextId')
  })
  params[0].padding = 'x'.repeat(snapshotArchiveRequestBytes - Buffer.byteLength(base))
  await expect(call('getSnapshotArchiveOffer', params)).resolves.toMatchObject({ chain: 'main' })
  expect(Buffer.byteLength(fetch.mock.calls.at(-1)![1]!.body as string)).toBe(snapshotArchiveRequestBytes)
})

test('the server admits exact request/response ceilings, including request ID one', async () => {
  const fixture = await snapshotHttpFixture()
  try {
    const { server, url } = await fixture.serve()
    const auth = new AuthFetch(fixture.wallet)
    const input = {
      jsonrpc: '2.0',
      method: 'getSnapshotArchiveOffer',
      params: [{ version: 1, identityKey: fixture.identityKey }],
      id: 1,
      padding: ''
    }
    input.padding = 'x'.repeat(snapshotArchiveRequestBytes - Buffer.byteLength(JSON.stringify(input)))
    const options = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [BINARY_ENCODING_HEADER]: BINARY_ENCODING },
      body: JSON.stringify(input)
    }
    const accepted = await auth.fetch(url, options)
    expect(await accepted.json()).toMatchObject({ jsonrpc: '2.0', id: 1, result: { version: 1, chain: 'test' } })
    const rpc = Reflect.get(server, 'snapshotArchives')
    const base = JSON.stringify({ jsonrpc: '2.0', result: { padding: '' }, id: 1 })
    jest
      .spyOn(rpc, 'dispatch')
      .mockResolvedValue({ padding: 'x'.repeat(snapshotArchiveResponseBytes - Buffer.byteLength(base)) })
    const response = await auth.fetch(url, options)
    expect(response.status).toBe(200)
    expect(Buffer.byteLength(await response.text())).toBe(snapshotArchiveResponseBytes)
  } finally {
    await fixture.close()
  }
})
