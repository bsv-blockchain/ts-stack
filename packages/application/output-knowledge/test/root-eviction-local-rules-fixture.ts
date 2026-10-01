import { SQLiteRootEvictionLocalRules } from '../src/root-eviction/SQLiteRootEvictionLocalRules.js'
import type {
  RootEvictionLocalRule,
  RootEvictionLocalRuleAssessment
} from '../src/root-eviction/RootEvictionLocalRules.js'
import type {
  RootEvictionConfiguration,
  RootEvictionServingTarget
} from '../src/root-eviction/RootEvictionStorage.js'
import { coordinationGuard } from './root-eviction-coordination-fixture.js'
import { fixture, requester, selected } from './root-eviction-fixture.js'

export const localRule = (): RootEvictionLocalRule => ({
  id: 'urn:test:advertiser-policy:1',
  parameters: { identity: requester },
  supportingDigest: 'aa'.repeat(32),
  operator: requester
})
export async function localRulesFixture(options: Partial<RootEvictionConfiguration> = {}) {
  const f = await fixture({ coordination: {}, localRules: {}, ...options })
  const rules = SQLiteRootEvictionLocalRules.open(f.path, f.configuration)
  const connections = [rules]
  let sequence = 0
  return {
    ...f,
    rules,
    guard: coordinationGuard(),
    nextId() {
      return `local_rule_operation_${++sequence}`
    },
    reopenRules() {
      const next = SQLiteRootEvictionLocalRules.open(f.path, f.configuration)
      connections.push(next)
      return next
    },
    async install(rule = localRule()) {
      return await rules.install(
        {
          operationId: `local_rule_install_${++sequence}`,
          expectedRevision: (await f.store.head()).revision,
          rule
        },
        coordinationGuard()
      )
    },
    async assess(
      matches: (boolean | null)[],
      target: RootEvictionServingTarget = selected(),
      eligible = true
    ) {
      const active = await rules.active(coordinationGuard())
      const input: RootEvictionLocalRuleAssessment = {
        operationId: `local_rule_assessment_${++sequence}`,
        expectedRevision: active.head.revision,
        ruleEpoch: active.value.epoch,
        target,
        eligible,
        evidenceDigest: 'bb'.repeat(32),
        reasonCode: 'verified-local-policy',
        matches: active.value.rules.map((rule, index) => ({
          decisionId: rule.decisionId,
          matches: matches[index]
        }))
      }
      const result = await rules.assess(input, coordinationGuard())
      return { input, result }
    },
    async project() {
      for (const intent of await f.store.projections(64)) await f.store.projected(intent)
    },
    async cleanup() {
      for (const connection of connections) await connection.close()
      await f.cleanup()
    }
  }
}
