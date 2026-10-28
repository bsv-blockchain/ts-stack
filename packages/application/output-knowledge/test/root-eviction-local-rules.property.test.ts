import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { apply, selected } from './root-eviction-fixture.js'
import { localRule, localRulesFixture } from './root-eviction-local-rules-fixture.js'

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
  'keeps peer bases, local coverage, currentness, projection and lifting independent across generated schedules',
  async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          count: fc.integer({ min: 1, max: 3 }),
          matches: fc.array(fc.constantFrom(true, false, null), { minLength: 3, maxLength: 3 }),
          current: fc.boolean(),
          projected: fc.boolean(),
          peer: fc.boolean(),
          lift: fc.integer({ min: -1, max: 2 })
        }),
        async schedule => {
          const f = await localRulesFixture()
          try {
            for (let i = 0; i < schedule.count; i++)
              await f.install({ ...localRule(), id: `urn:test:generated:${i}:1` })
            if (schedule.peer) await apply(f.store)
            const active = (await f.rules.active(f.guard)).value
            const decisions = new Map(
              active.rules.map((rule, index) => [rule.decisionId, schedule.matches[index]])
            )
            const first = await f.assess(
              schedule.matches.slice(0, schedule.count),
              selected(),
              schedule.current
            )
            if (schedule.projected) await f.project()
            const state = () => {
              const values = [...decisions.values()]
              if (schedule.peer || values.includes(true)) return 'suppressed'
              return schedule.current && !values.includes(null) && schedule.projected
                ? 'eligible'
                : 'unresolved'
            }
            expect((await f.store.serving(selected())).state).toBe(state())
            if (schedule.lift >= 0 && schedule.lift < active.rules.length) {
              const affected = active.rules[schedule.lift].decisionId
              await f.rules.lift(
                {
                  operationId: f.nextId(),
                  expectedRevision: (await f.store.head()).revision,
                  decisionId: affected,
                  operator: localRule().operator,
                  supportingDigest: 'cc'.repeat(32)
                },
                f.guard
              )
              decisions.delete(affected)
              const blocked = schedule.peer || [...decisions.values()].includes(true)
              expect((await f.store.serving(selected())).state).toBe(
                blocked ? 'suppressed' : 'unresolved'
              )
              const before = await f.store.head()
              expect((await f.reopenRules().assess(first.input, f.guard)).value).toBe(
                first.result.value
              )
              expect(await f.store.head()).toEqual(before)
              expect((await f.store.serving(selected())).state).toBe(
                blocked ? 'suppressed' : 'unresolved'
              )
              const current = await f.rules.active(f.guard)
              await f.assess(
                current.value.rules.map(rule => decisions.get(rule.decisionId)!),
                selected(),
                schedule.current
              )
              if (schedule.projected) await f.project()
              expect((await f.store.serving(selected())).state).toBe(state())
            }
            expect(
              (await f.reopenRules().active(f.guard)).value.rules.map(rule => rule.decisionId)
            ).toEqual([...decisions.keys()])
          } finally {
            await f.cleanup()
          }
        }
      )
    )
  },
  Math.min(2147483647, Math.max(120000, propertyRuns * 400))
)
