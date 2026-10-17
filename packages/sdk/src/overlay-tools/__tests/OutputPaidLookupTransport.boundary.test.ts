import { jest } from '@jest/globals'
import {
  AuthFetch,
  SimplifiedFetchTransport,
  OutputProtocolError,
  type OutputCapabilitySelection
} from '../../../mod.js'
import { OutputFiniteHTTP } from '../internal/OutputFiniteHTTP.js'
import { paidTransportFixture, paidBuyer } from './OutputPaidLookupTransport.fixture.js'
afterEach(() => jest.restoreAllMocks())
const messages = {
  fetch: 'fetch',
  timeout: 'timeout',
  headers: 'headers',
  responseEndpoint: 'response-endpoint',
  encoding: 'encoding',
  cancelled: 'cancelled',
  active: 'active',
  deadline: 'deadline',
  contract: 'contract',
  payment: 'payment',
  status: 'status',
  endpoint: 'endpoint',
  body: 'body'
}
function helper(change?: (selection: OutputCapabilitySelection) => void) {
  const f = paidTransportFixture('quote'),
    selection = structuredClone({ ...f.selection, headers: { ...f.selection.headers } })
  change?.(selection)
  const http = new OutputFiniteHTTP({
    selection,
    wallet: f.options.wallet,
    fetch: f.fetchClient,
    messages,
    serviceError: packet =>
      new OutputProtocolError(packet.error.code, packet.error.message, packet.error.retryable)
  })
  return { ...f, http }
}
const url = 'https://provider.example.test/api/overlay/v1/private/acquire'
it.each(['id', 'authentication', 'payment'] as const)(
  'requires the explicit paid profile %s at the finite boundary',
  async field => {
    const f = helper(selection => {
        Object.assign(selection.profile, { [field]: 'none' })
      }),
      send = jest.spyOn(AuthFetch.prototype, 'fetch')
    await expect(
      f.http.exchangeAcquisition(url, '{}', 4096, {
        buyer: f.request.recipient,
        allowChallenge: true
      })
    ).rejects.toMatchObject({ code: 'unsupported' })
    expect(send).not.toHaveBeenCalled()
  }
)
it.each([undefined, 'yes', 0, null])(
  'rejects a non-boolean challenge selector %s before I/O',
  async allowChallenge => {
    const f = helper(),
      send = jest.spyOn(AuthFetch.prototype, 'fetch')
    await expect(
      f.http.exchangeAcquisition(url, '{}', 4096, {
        buyer: f.request.recipient,
        allowChallenge
      } as never)
    ).rejects.toThrow('challenge mode')
    expect(send).not.toHaveBeenCalled()
  }
)
it.each(['', 'x'.repeat(98305), 'é'.repeat(49153), 42])(
  'bounds explicit payment bytes before invoking authentication',
  async paymentHeader => {
    const f = helper(),
      send = jest.spyOn(AuthFetch.prototype, 'fetch')
    await expect(
      f.http.exchangeAcquisition(url, '{}', 4096, {
        buyer: f.request.recipient,
        allowChallenge: false,
        paymentHeader
      } as never)
    ).rejects.toMatchObject({ code: 'limited' })
    expect(send).not.toHaveBeenCalled()
  }
)
it('accepts the exact header representation bound and refuses simultaneous paid/challenge modes', async () => {
  const f = helper(),
    send = jest
      .spyOn(AuthFetch.prototype, 'fetch')
      .mockImplementation(async () => f.response(f.quoted, 200)),
    paymentHeader = 'x'.repeat(98304)
  const response = await f.http.exchangeAcquisition(url, '{}', 4096, {
    buyer: f.request.recipient,
    allowChallenge: false,
    paymentHeader
  })
  expect(response.statusCode).toBe(200)
  expect(new Headers(send.mock.calls[0][1]!.headers).get('x-bsv-payment')).toBe(paymentHeader)
  await expect(
    f.http.exchangeAcquisition(url, '{}', 4096, {
      buyer: f.request.recipient,
      allowChallenge: true,
      paymentHeader
    })
  ).rejects.toThrow('another challenge')
  expect(send).toHaveBeenCalledTimes(1)
})
it('checks wallet identity again when its capability changes across asynchronous identity work', async () => {
  const f = paidTransportFixture('quote'),
    wallet = f.options.wallet,
    original = wallet.getPublicKey.bind(wallet)
  wallet.getPublicKey = async args => {
    const value = await original(args)
    wallet.getPublicKey = original
    return value
  }
  const { OutputPaidLookupTransport } = await import('../OutputPaidLookupTransport.js')
  const client = new OutputPaidLookupTransport(f.options),
    send = jest.spyOn(AuthFetch.prototype, 'fetch')
  await expect(client.send()).rejects.toMatchObject({ code: 'unauthorized' })
  expect(send).not.toHaveBeenCalled()
})
it('refuses a changed wallet after an authenticated HTTP response has settled', async () => {
  const f = paidTransportFixture('quote'),
    original = f.options.wallet.getPublicKey.bind(f.options.wallet)
  jest.spyOn(AuthFetch.prototype, 'fetch').mockImplementation(async () => {
    f.options.wallet.getPublicKey = original
    return f.response()
  })
  await expect(f.client.send()).rejects.toMatchObject({ code: 'context-changed' })
})
it.each([131072, 131073])('applies the whole outgoing header ceiling at %i bytes', async bytes => {
  const f = paidTransportFixture('quote')
  f.fetchClient.mockImplementation(async () => f.response())
  jest.spyOn(SimplifiedFetchTransport.prototype, 'send').mockImplementation(async function (
    this: SimplifiedFetchTransport
  ) {
    await this.fetchClient(new URL(url), {
      method: 'POST',
      headers: { 'x-padding': 'x'.repeat(bytes - 30) }
    })
    throw new Error('Synthetic transport stopped after bounded fetch')
  })
  await expect(f.client.send()).rejects.toThrow(
    bytes === 131072 ? 'Synthetic transport stopped' : 'header limit'
  )
  expect(f.fetchClient).toHaveBeenCalledTimes(bytes === 131072 ? 1 : 0)
})
it('allows only the selected origin authentication endpoint and bounds its response separately', async () => {
  const f = paidTransportFixture('quote')
  const authURL = 'https://provider.example.test/.well-known/auth'
  f.fetchClient.mockResolvedValue(new Response('x'.repeat(1048577)))
  jest.spyOn(SimplifiedFetchTransport.prototype, 'send').mockImplementation(async function (
    this: SimplifiedFetchTransport
  ) {
    await this.fetchClient(new Request(authURL), { method: 'POST' })
    throw new Error('Fixture expected authentication bound')
  })
  await expect(f.client.send()).rejects.toThrow('byte limit')
  expect(f.fetchClient).toHaveBeenCalledWith(
    expect.any(Request),
    expect.objectContaining({ redirect: 'error', credentials: 'omit', cache: 'no-store' })
  )
})
it('refuses malformed UTF-8 and duplicated protocol keys after authentication', async () => {
  const f = paidTransportFixture('quote'),
    send = jest.spyOn(AuthFetch.prototype, 'fetch')
  const headers = f.response().headers
  for (const bytes of [
    Uint8Array.from([0xff]),
    new TextEncoder().encode(
      JSON.stringify(f.challenge).replace('"version":1', '"version":1,"version":1')
    )
  ]) {
    send.mockImplementation(async () => new Response(bytes, { status: 402, headers }))
    await expect(f.client.send()).rejects.toMatchObject({ code: 'invalid' })
  }
})
it('requires the original buyer to be an actual valid identity before wallet work', async () => {
  const f = helper(),
    send = jest.spyOn(AuthFetch.prototype, 'fetch')
  await expect(
    f.http.exchangeAcquisition(url, '{}', 4096, { buyer: 'not-a-key', allowChallenge: true })
  ).rejects.toThrow()
  expect(send).not.toHaveBeenCalled()
  expect(paidBuyer.toPublicKey().toString()).toBe(f.request.recipient)
})
