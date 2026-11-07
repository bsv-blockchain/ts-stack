import { jest } from '@jest/globals'
import fc from 'fast-check'
import { AuthFetch, signOutputPacket } from '../../../mod.js'
import { rootTransportFixture } from './OutputRootEvictionTransport.fixture.js'
import { rootKey, rootOutcome, rootResultBody } from './OutputRootEvictionProtocol.fixture.js'

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

test('root status/submit schedules keep the original operation and independently retained policy', async () => {
  const f = rootTransportFixture()
  const send = jest.spyOn(AuthFetch.prototype, 'fetch')
  await fc.assert(
    fc.asyncProperty(
      fc.boolean(),
      fc.boolean(),
      fc.bigInt({ min: 1n, max: 18446744073709551614n }),
      async (status, changedPolicy, revision) => {
        const body = rootResultBody(f.request.body)
        body.outcomes = [rootOutcome(f.request.body, String(revision))]
        if (changedPolicy) body.policyDigest = 'ab'.repeat(32)
        const packet = signOutputPacket('root-eviction-result', body, rootKey)
        send.mockImplementation(async () => f.response(packet))
        const operation = status ? f.client.status() : f.client.submit()
        if (changedPolicy) await expect(operation).rejects.toThrow()
        else expect(await operation).toEqual(packet)
        const [url, init] = send.mock.calls.at(-1)!
        expect(url).toBe(
          'https://root.example.test/api/overlay/v1/root-evictions/' +
            (status ? 'status' : 'request')
        )
        expect(JSON.parse(init!.body as string)).toEqual(
          status
            ? {
                version: 1,
                requester: f.request.body.requester,
                requestId: f.request.body.requestId
              }
            : f.request
        )
        expect(init).toMatchObject({
          allowPayments: false,
          requireMutualAuth: true,
          expectedIdentityKey: f.request.body.recipient
        })
      }
    )
  )
})
