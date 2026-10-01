import { jest } from '@jest/globals'
import { AuthFetch, OUTPUT_PROFILES, outputPacketDigest, signOutputPacket } from '../../../mod.js'
import { OutputProposalTransport, OutputProposalServiceError } from '../OutputProposalTransport.js'
import {
  proposalTransportFixture,
  proposalAuthor,
  proposalProvider,
  proposalPolicy,
  transportProposal
} from './OutputProposalTransport.fixture.js'

afterEach(() => jest.restoreAllMocks())

it.each(['put', 'get', 'finalize'] as const)(
  'retries an owned %s request under its original retained contract',
  async operation => {
    const f = proposalTransportFixture(operation)
    const original = structuredClone(f.requests[operation])
    const send = jest
      .spyOn(AuthFetch.prototype, 'fetch')
      .mockImplementation(async () => f.response())
    f.options.request = { replacement: true }
    f.record.manifest.body.baseURL = 'https://changed.example'
    f.record.selectedAt = '9999'
    const first = await f.client.send()
    expect(first).toEqual(
      operation === 'finalize'
        ? { response: f.results.finalize, matchesRequest: true }
        : f.results[operation]
    )
    expect(await f.client.send()).toEqual(first)
    expect(send).toHaveBeenCalledTimes(2)
    for (const [url, init] of send.mock.calls) {
      expect(url).toBe('https://provider.example.test/api/overlay/v1/proposals/' + operation)
      expect(JSON.parse(init!.body as string)).toEqual(original)
      expect(init).toMatchObject({
        method: 'POST',
        allowPayments: false,
        requireMutualAuth: true,
        expectedIdentityKey: f.selection.manifest.body.identity,
        headers: {
          'x-bsv-overlay-profile': OUTPUT_PROFILES.proposal,
          'x-bsv-overlay-capability': f.selection.digest
        }
      })
    }
  }
)

it.each(['kind', 'profile'] as const)('rejects the wrong selected %s before I/O', key => {
  const f = proposalTransportFixture('get')
  expect(
    () =>
      new OutputProposalTransport({
        ...f.options,
        trust: { ...f.options.trust, [key]: 'other' } as never
      })
  ).toThrow('topic proposal profile')
  expect(f.fetchClient).not.toHaveBeenCalled()
})

it('requires a wallet, supported operation, and exact request service/policy', () => {
  const f = proposalTransportFixture('get')
  expect(() => new OutputProposalTransport({ ...f.options, wallet: undefined as never })).toThrow(
    'wallet'
  )
  expect(() => new OutputProposalTransport({ ...f.options, operation: 'other' as never })).toThrow(
    'operation'
  )
  expect(
    () =>
      new OutputProposalTransport({
        ...f.options,
        request: { ...f.requests.get, service: 'other' }
      })
  ).toThrow('service changed')
  expect(
    () =>
      new OutputProposalTransport({
        ...f.options,
        request: {
          ...f.requests.get,
          policy: { ...f.requests.get.policy, digest: 'ff'.repeat(32) }
        }
      })
  ).toThrow('not enabled')
})

it.each(['service', 'chain', 'policy', 'signature', 'lifetime'] as const)(
  'validates a saved publication %s independently',
  kind => {
    const f = proposalTransportFixture('put')
    const body = structuredClone(f.proposal.body)
    if (kind === 'service') body.service = 'other'
    if (kind === 'chain') body.chain.genesisHash = 'ff'.repeat(32)
    if (kind === 'policy') body.policy.id = 'urn:test:other:1'
    if (kind === 'lifetime') body.expiresAt = '200'
    const proposal = signOutputPacket('proposal', body, proposalAuthor)
    if (kind === 'signature') proposal.body.payload = 'AA=='
    expect(
      () => new OutputProposalTransport({ ...f.options, request: { version: 1, proposal } })
    ).toThrow()
  }
)

it.each(['proposalId', 'expiresAt'] as const)(
  'binds recorded acknowledgement %s exactly',
  async key => {
    const f = proposalTransportFixture('put')
    const value = { ...f.results.put, [key]: key === 'proposalId' ? 'ff'.repeat(32) : '121' }
    jest.spyOn(AuthFetch.prototype, 'fetch').mockImplementation(async () => f.response(value))
    await expect(f.client.send()).rejects.toMatchObject({ code: 'context-changed' })
  }
)

it('binds get to the signed channel and rejects stale active state while preserving history', async () => {
  const f = proposalTransportFixture('get')
  let value: unknown = f.results.get
  jest.spyOn(AuthFetch.prototype, 'fetch').mockImplementation(async () => f.response(value))
  value = { ...f.results.get, proposal: transportProposal({ channel: 'ff'.repeat(32) }) }
  await expect(f.client.send()).rejects.toMatchObject({ code: 'context-changed' })
  value = f.results.get
  f.state.now = '119'
  expect(await f.client.send()).toEqual(f.results.get)
  f.state.now = '120'
  await expect(f.client.send()).rejects.toMatchObject({ code: 'expired' })
  value = { ...f.results.get, state: { status: 'expired', recordedAt: '120' } }
  expect(await f.client.send()).toEqual(value)
})

it('distinguishes a previously reserved transaction without pretending it fulfills the current request', async () => {
  const f = proposalTransportFixture('finalize')
  let value = f.results.finalize
  jest.spyOn(AuthFetch.prototype, 'fetch').mockImplementation(async () => f.response(value))
  expect((await f.client.send()).matchesRequest).toBe(true)
  for (const state of [
    { ...f.results.finalize.state, operationId: 'previous_operation_1' },
    { ...f.results.finalize.state, txid: 'ff'.repeat(32) }
  ]) {
    value = { ...f.results.finalize, state }
    expect(await f.client.send()).toEqual({ response: value, matchesRequest: false })
  }
  value = {
    ...f.results.finalize,
    proposalId: outputPacketDigest('proposal', transportProposal({ channel: '33'.repeat(32) }).body)
  }
  await expect(f.client.send()).rejects.toMatchObject({ code: 'context-changed' })
})

it('does not mistake an active proposal for a finalization reservation', async () => {
  const f = proposalTransportFixture('finalize')
  jest.spyOn(AuthFetch.prototype, 'fetch').mockImplementation(async () =>
    f.response({
      version: 1,
      proposalId: f.proposalId,
      state: { status: 'active', recordedAt: '100' }
    })
  )
  await expect(f.client.send()).rejects.toThrow('reserved admission')
})

it('preserves authenticated service errors and refuses mismatched status and automatic payment', async () => {
  const f = proposalTransportFixture('get')
  const packet = {
    version: 1,
    error: { code: 'not-found', message: 'No current proposal', retryable: false }
  }
  const send = jest
    .spyOn(AuthFetch.prototype, 'fetch')
    .mockImplementation(async () => f.response(packet, 404))
  await expect(f.client.send()).rejects.toBeInstanceOf(OutputProposalServiceError)
  send.mockImplementation(async () => f.response(packet, 409))
  await expect(f.client.send()).rejects.toThrow('status mismatch')
  send.mockImplementation(async () => f.response(packet, 402))
  await expect(f.client.send()).rejects.toMatchObject({ code: 'unsupported' })
  expect(f.fetchClient).not.toHaveBeenCalled()
})

it('honors selected byte limits exactly for requests and responses', async () => {
  const reference = proposalTransportFixture('get')
  const requestBytes = Buffer.byteLength(JSON.stringify(reference.requests.get))
  expect(() =>
    proposalTransportFixture('get', {}, manifest => {
      manifest.services[0].profiles[0].maxRequestBytes = requestBytes
    })
  ).not.toThrow()
  expect(() =>
    proposalTransportFixture('get', {}, manifest => {
      manifest.services[0].profiles[0].maxRequestBytes = requestBytes - 1
    })
  ).toThrow()
  const bytes = Buffer.byteLength(JSON.stringify(reference.results.get))
  const exact = proposalTransportFixture('get', {}, manifest => {
    manifest.services[0].profiles[0].maxResponseBytes = bytes
  })
  const small = proposalTransportFixture('get', {}, manifest => {
    manifest.services[0].profiles[0].maxResponseBytes = bytes - 1
  })
  const send = jest
    .spyOn(AuthFetch.prototype, 'fetch')
    .mockImplementation(async () => exact.response())
  expect(await exact.client.send()).toEqual(exact.results.get)
  send.mockImplementation(async () => small.response())
  await expect(small.client.send()).rejects.toMatchObject({
    name: 'LookupResourceLimitError',
    limit: 'maxResponseBytes'
  })
})

it('requires HTTPS even when another profile permits local HTTP', () => {
  const f = proposalTransportFixture('get')
  const manifest = structuredClone(f.record.manifest.body)
  manifest.baseURL = 'http://localhost/api'
  const trust = { ...f.options.trust, baseURL: manifest.baseURL, allowLocalHTTP: true }
  const record = {
    ...f.record,
    manifest: signOutputPacket('capabilities', manifest, proposalProvider)
  }
  expect(() => new OutputProposalTransport({ ...f.options, contract: record, trust })).toThrow()
})

it('uses the trusted clock for active results and requires a canonical clock value', async () => {
  const f = proposalTransportFixture('get', { now: undefined })
  const clock = jest.spyOn(Date, 'now').mockReturnValue(119999)
  jest.spyOn(AuthFetch.prototype, 'fetch').mockImplementation(async () => f.response())
  expect(await f.client.send()).toEqual(f.results.get)
  clock.mockReturnValue(120000)
  await expect(f.client.send()).rejects.toMatchObject({ code: 'expired' })
  const invalid = proposalTransportFixture('get', { now: () => '01' })
  await expect(invalid.client.send()).rejects.toThrow()
})

it('binds the returned policy separately when multiple policies are advertised', async () => {
  const alternate = { id: 'urn:test:document:2', parameters: { maxTextBytes: 2048 } }
  const second = { ...alternate, digest: outputPacketDigest('proposal-policy', alternate) }
  const f = proposalTransportFixture('get', {}, manifest => {
    manifest.services[0].profiles[0].parameters.policies = [proposalPolicy, second]
  })
  const proposal = transportProposal({ policy: { id: second.id, digest: second.digest } })
  jest
    .spyOn(AuthFetch.prototype, 'fetch')
    .mockImplementation(async () => f.response({ ...f.results.get, proposal }))
  await expect(f.client.send()).rejects.toMatchObject({ code: 'context-changed' })
})

it.each(['x-bsv-overlay-profile', 'x-bsv-overlay-capability'] as const)(
  'rejects changed signed %s',
  async header => {
    const f = proposalTransportFixture('get')
    jest
      .spyOn(AuthFetch.prototype, 'fetch')
      .mockImplementation(async () => f.response(undefined, 200, { [header]: 'changed' }))
    await expect(f.client.send()).rejects.toThrow('selected contract')
  }
)

it('keeps physical I/O ownership after cancellation and permits only exact recovery after settlement', async () => {
  const f = proposalTransportFixture('put')
  let settle!: (value: Response) => void
  const pending = new Promise<Response>(resolve => {
    settle = resolve
  })
  const send = jest.spyOn(AuthFetch.prototype, 'fetch').mockImplementation(() => pending)
  const controller = new AbortController()
  const first = f.client.send(controller.signal)
  await new Promise<void>(resolve => setImmediate(resolve))
  controller.abort()
  await expect(first).rejects.toMatchObject({ code: 'cancelled' })
  await expect(f.client.send()).rejects.toMatchObject({ code: 'limited' })
  expect(send).toHaveBeenCalledTimes(1)
  settle(f.response())
  await new Promise<void>(resolve => setImmediate(resolve))
  send.mockImplementation(async () => f.response())
  expect(await f.client.send()).toEqual(f.results.put)
  expect(send.mock.calls[1][1]!.body).toEqual(send.mock.calls[0][1]!.body)
})

it('preserves an authenticated error packet by value', () => {
  const packet = { version: 1, error: { code: 'limited', message: 'Capacity', retryable: true } }
  const error = new OutputProposalServiceError(packet as never)
  packet.error.message = 'changed'
  expect(error.name).toBe('OutputProposalServiceError')
  expect(error.message).toBe('Capacity')
  expect(error.packet.error).toEqual({ code: 'limited', message: 'Capacity', retryable: true })
})
