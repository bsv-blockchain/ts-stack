import { jest } from '@jest/globals'
import fc from 'fast-check'
import { AuthFetch } from '../../../mod.js'
import { proposalTransportFixture, transportProposal } from './OutputProposalTransport.fixture.js'

const MIN_PROPERTY_RUNS = 300
const runs = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const seed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const path = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(runs) ? Math.max(MIN_PROPERTY_RUNS, runs) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(seed) ? { seed } : {}),
  ...(path ? { path } : {})
})
afterEach(() => jest.restoreAllMocks())

test('proposal operations preserve original requests while distinguishing returned channels, expiry and reservations', async () => {
  const fixtures = {
    put: proposalTransportFixture('put'),
    get: proposalTransportFixture('get'),
    finalize: proposalTransportFixture('finalize')
  }
  const send = jest.spyOn(AuthFetch.prototype, 'fetch')
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom('put', 'get', 'finalize'),
      fc.boolean(),
      fc.boolean(),
      fc.bigInt({ min: 1n, max: 18446744073709551615n }),
      async (operation, changed, expired, revision) => {
        if (operation === 'put') {
          const f = fixtures.put
          const packet = { ...f.results.put, ...(changed ? { proposalId: 'ff'.repeat(32) } : {}) }
          send.mockImplementation(async () => f.response(packet))
          if (changed)
            await expect(f.client.send()).rejects.toMatchObject({ code: 'context-changed' })
          else expect(await f.client.send()).toEqual(packet)
        } else if (operation === 'get') {
          const f = fixtures.get
          f.state.now = expired ? '120' : '119'
          const proposal = transportProposal({
            revision: String(revision),
            previous: '22'.repeat(32),
            ...(changed ? { channel: 'ff'.repeat(32) } : {})
          })
          const packet = { ...f.results.get, proposal }
          send.mockImplementation(async () => f.response(packet))
          if (changed || expired)
            await expect(f.client.send()).rejects.toMatchObject({
              code: changed ? 'context-changed' : 'expired'
            })
          else expect(await f.client.send()).toEqual(packet)
        } else {
          const f = fixtures.finalize
          const packet = {
            ...f.results.finalize,
            state: {
              ...f.results.finalize.state,
              ...(changed ? { operationId: 'previous_operation_1' } : {}),
              ...(expired ? { txid: 'ff'.repeat(32) } : {})
            }
          }
          send.mockImplementation(async () => f.response(packet))
          expect(await f.client.send()).toEqual({
            response: packet,
            matchesRequest: !changed && !expired
          })
        }
        const f = fixtures[operation],
          [url, init] = send.mock.calls.at(-1)!
        expect(url).toBe('https://provider.example.test/api/overlay/v1/proposals/' + operation)
        expect(JSON.parse(init!.body as string)).toEqual(f.requests[operation])
        expect(init).toMatchObject({
          allowPayments: false,
          requireMutualAuth: true,
          expectedIdentityKey: f.selection.manifest.body.identity
        })
      }
    )
  )
})
