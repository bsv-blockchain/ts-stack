import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { canonicalOutputJSON } from '@bsv/sdk'
import { RootEvictionContracts } from '../src/root-eviction/RootEvictionContracts.js'
import { rootContractTrust } from './root-contract-fixture.js'
import { requester, signed } from './root-eviction-fixture.js'
import {
  coordinatedFixture,
  coordinatedRequest,
  contractSelection,
  coordinationGuard
} from './root-eviction-coordination-fixture.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
const propertyRuns = Number.isSafeInteger(requestedRuns)
  ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
  : MIN_PROPERTY_RUNS
fc.configureGlobal({
  numRuns: propertyRuns,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

it(
  'keeps contract capacity atomic and the original selector immutable across generated retry and restart histories',
  async () => {
    const selection = contractSelection(),
      contracts = new RootEvictionContracts(rootContractTrust())
    const bytes = Buffer.byteLength(
      canonicalOutputJSON(contracts.retain(selection.manifest, selection.selector, '150').record)
    )
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -1, max: 1 }),
        fc.nat(1000000),
        fc.integer({ min: 201, max: 10000 }),
        async (delta, id, later) => {
          const f = await coordinatedFixture({ coordination: { contractBytes: bytes + delta } })
          try {
            const body = coordinatedRequest(`generated_contract_${id}`)
            const retain = () =>
              f.store.retainCoordinated(
                signed(body),
                requester,
                selection,
                contracts,
                coordinationGuard()
              )
            if (delta < 0) {
              await expect(retain()).rejects.toMatchObject({
                code: 'limited',
                message: expect.stringMatching(/\S/)
              })
              expect(await f.store.get(requester, body.requestId)).toBeUndefined()
              expect((await f.store.head()).revision).toBe('0')
            } else {
              const first = await retain(),
                reopened = f.reopen()
              const retry = await reopened.retainCoordinated(
                signed(body),
                requester,
                { ...selection, manifest: null },
                contracts,
                coordinationGuard(later.toString())
              )
              expect(retry.value).toEqual(first.value)
              const status = await reopened.resultCoordinated(
                requester,
                body.requestId,
                selection.selector,
                contracts,
                coordinationGuard(later.toString())
              )
              expect(status.value.retained.contract.selection.digest).toBe(selection.selector)
              expect(status.value.result.outcomes[0]).toMatchObject({
                actionStatus: 'rejected',
                reasonCode: 'request-expired',
                revision: '1'
              })
              await expect(
                reopened.resultCoordinated(
                  requester,
                  body.requestId,
                  'ff'.repeat(32),
                  contracts,
                  coordinationGuard(later.toString())
                )
              ).rejects.toMatchObject({
                code: 'context-changed',
                message: expect.stringMatching(/\S/)
              })
              expect((await reopened.head()).revision).toBe('1')
              expect(await reopened.get(requester, body.requestId)).toEqual({
                request: first.value.request,
                digest: first.value.digest,
                policyDigest: first.value.policyDigest
              })
            }
          } finally {
            await f.cleanup()
          }
        }
      )
    )
  },
  Math.min(2147483647, Math.max(120000, propertyRuns * 400))
)
