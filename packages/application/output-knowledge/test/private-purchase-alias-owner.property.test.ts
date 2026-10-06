import { expect, test } from '@jest/globals'
import fc from 'fast-check'
import { canonicalOutputJSON } from '@bsv/sdk'
import { purchaseAliasOwnerFixture } from './private-purchase-alias-owner.fixture.js'

const MIN_PROPERTY_RUNS = 300
const runs = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10),
  seed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10),
  replay = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(runs) ? Math.max(MIN_PROPERTY_RUNS, runs) : MIN_PROPERTY_RUNS,
  seed: Number.isSafeInteger(seed) ? seed : 3242026,
  ...(replay ? { path: replay } : {})
})

test('generated native effect histories retain one identity and first result across alias selection and reopened owners', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.boolean(),
      fc.array(fc.constantFrom('select', 'admit', 'reopen', 'retry', 'read'), {
        minLength: 1,
        maxLength: 6
      }),
      async (deliver, history) => {
        const f = purchaseAliasOwnerFixture()
        let use = f.store,
          aliases = f.f.owner,
          domain = f.base.owner.domain
        try {
          f.prepare()
          const original = f.f.variant(10)
          let candidate = original
          f.retain(original)
          f.admitted(original)
          const firstTime = f.load().state.firstReservedAt
          let expected: string | undefined
          if (deliver) {
            const admitted = f.load(),
              envelope = f.envelope(admitted)
            use.complete(admitted, envelope, undefined, f.f.clock, f.f.guard)
            expected = canonicalOutputJSON(envelope)
          }
          let variant = 11
          for (const action of history) {
            if (action === 'reopen') {
              f.base.close(domain)
              const opened = f.reopen()
              use = opened.owner
              aliases = opened.aliases
              domain = opened.domain
            }
            if (action === 'select') {
              candidate = f.f.variant(variant++)
              f.retain(candidate, true, use, aliases)
            }
            if (action === 'retry') f.retain(candidate, true, use, aliases)
            if (action === 'admit') f.admitted(candidate, aliases)
            const saved = f.load(use)
            expect(saved.state.firstReservedAt).toBe(firstTime)
            expect(saved.aliases.state.original?.txid).toBe(original.txid)
            expect(saved.aliases.state.purchaseCommitment).toBe('b1'.repeat(32))
            if (deliver) {
              expect(saved.progress.txid).toBe(original.txid)
              expect(saved.aliases.state.historical?.txid).toBe(original.txid)
              let disclosed: unknown
              use.disclose(saved, f.base.buyer, f.f.clock, f.f.guard, value => {
                disclosed = value
              })
              expect(canonicalOutputJSON(disclosed)).toBe(expected)
            } else {
              expect(saved.progress.status).not.toBe('delivered')
              expect(saved.aliases.state.historical).toBeNull()
              expect(saved.state.result.digest).toBeNull()
            }
          }
        } finally {
          f.base.dispose()
        }
      }
    ),
    { interruptAfterTimeLimit: 150000, markInterruptAsFailure: true }
  )
}, 180000)

test('generated terminal-failure recovery histories preserve the exact paid candidate and local decision without a private release', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom('reopen', 'select', 'retry', 'read'), {
        minLength: 1,
        maxLength: 6
      }),
      async history => {
        const f = purchaseAliasOwnerFixture()
        let use = f.store,
          aliases = f.f.owner,
          domain = f.base.owner.domain
        try {
          f.prepare()
          const paid = f.f.variant(30)
          f.retain(paid)
          f.admitted(paid)
          const failed = use.fail(
            f.load(),
            { reason: 'Irrecoverable material', evidence: 'AA==' },
            f.f.clock,
            f.f.guard
          )
          const expected = structuredClone(failed.progress),
            firstTime = failed.state.firstReservedAt
          let variant = 31
          for (const action of history) {
            if (action === 'reopen') {
              f.base.close(domain)
              const opened = f.reopen()
              use = opened.owner
              aliases = opened.aliases
              domain = opened.domain
            }
            if (action === 'select') f.retain(f.f.variant(variant++), true, use, aliases)
            const saved = f.load(use)
            if (action === 'retry')
              expect(
                use.fail(
                  saved,
                  { reason: 'Irrecoverable material', evidence: 'AA==' },
                  f.f.clock,
                  f.f.guard
                ).revision
              ).toBe(saved.revision)
            expect(saved.progress).toEqual(expected)
            expect(saved.candidate).toEqual(paid)
            expect(saved.state.firstReservedAt).toBe(firstTime)
            expect(saved.aliases.state.historical).toBeNull()
            let disclosed: unknown
            use.disclose(saved, f.base.buyer, f.f.clock, f.f.guard, value => {
              disclosed = value
            })
            expect(disclosed).toMatchObject({
              result: { status: 'delivery-failed', txid: paid.txid, decision: expected.decision }
            })
            expect(Object.hasOwn(disclosed as object, 'releaseEvidence')).toBe(false)
          }
        } finally {
          f.base.dispose()
        }
      }
    ),
    { interruptAfterTimeLimit: 150000, markInterruptAsFailure: true }
  )
}, 180000)
