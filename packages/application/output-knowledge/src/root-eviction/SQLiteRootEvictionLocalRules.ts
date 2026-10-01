import {
  canonicalOutputJSON,
  Hash,
  incrementOutputU64,
  closedOutputObject,
  type OutputJSONObject,
  outputAssert,
  outputHex32,
  outputIdentity,
  outputString,
  outputU64,
  parseOutputJSON,
  parseOutputRootEvictionStatus,
  Utils
} from '@bsv/sdk'
import { synchronousPromise } from '../internal/synchronousPromise.js'
import {
  rootBytes,
  rootDecimal,
  rootPosition,
  rootTarget,
  rootTargetKey
} from './RootEvictionCodec.js'
import {
  rootCommitContext,
  type RootEvictionCommitGuard,
  type RootEvictionObservation
} from './RootEvictionCommitContext.js'
import type {
  RootEvictionLocalRule,
  RootEvictionLocalRuleAssessment,
  RootEvictionLocalRuleRecord,
  RootEvictionLocalRuleSet,
  RootEvictionLocalRulesStorage
} from './RootEvictionLocalRules.js'
import { rootLocalRuleReservation } from './RootEvictionLocalRuleSchema.js'
import { RootEvictionServingRecords } from './RootEvictionServingRecords.js'
import type { RootEvictionConfiguration } from './RootEvictionStorage.js'
import { SQLiteRootEvictionDatabase } from './SQLiteRootEvictionDatabase.js'

/**
 * Trusted local format3 administration and complete rule-coverage assessments.
 * No public route, peer-request authority, matcher installation or Bitcoin
 * verification is inferred. Uses the same gate as every decision/final enqueue.
 */
export class SQLiteRootEvictionLocalRules implements RootEvictionLocalRulesStorage {
  readonly durability = 'durable' as const
  private readonly database: SQLiteRootEvictionDatabase
  private readonly views: RootEvictionServingRecords

  private constructor(path: string, configuration: RootEvictionConfiguration) {
    outputAssert(
      configuration.localRules !== undefined,
      'Root local rules require explicit format3 configuration'
    )
    this.database = new SQLiteRootEvictionDatabase(path, configuration, undefined)
    this.views = new RootEvictionServingRecords(this.database)
  }
  static open(
    path: string,
    configuration: RootEvictionConfiguration
  ): SQLiteRootEvictionLocalRules {
    return new SQLiteRootEvictionLocalRules(path, configuration)
  }
  private work<T>(
    guard: RootEvictionCommitGuard,
    body: () => T
  ): Promise<RootEvictionObservation<T>> {
    return synchronousPromise(() =>
      this.database.transaction(() => {
        const observedAt = rootCommitContext(this.database.head(), guard)
        const value = body()
        return { value, head: this.database.head(), observedAt }
      })
    )
  }
  private epoch(): string {
    return rootDecimal(this.database.get('SELECT epoch FROM root_rule_meta WHERE id=1')?.epoch)
  }
  private descriptor(input: unknown): RootEvictionLocalRule {
    const owned = parseOutputJSON(canonicalOutputJSON(input, { bytes: 16384 }), { bytes: 16384 })
    closedOutputObject(owned, ['id', 'parameters', 'supportingDigest', 'operator'])
    outputAssert(
      owned.parameters !== null &&
        typeof owned.parameters === 'object' &&
        !Array.isArray(owned.parameters),
      'Invalid local rule parameters'
    )
    return {
      id: outputString(owned.id),
      parameters: owned.parameters as OutputJSONObject,
      supportingDigest: outputHex32(owned.supportingDigest),
      operator: outputIdentity(owned.operator)
    }
  }
  private record(decisionId: string): RootEvictionLocalRuleRecord | undefined {
    const row = this.database.get(
      'SELECT * FROM root_local_rules WHERE decision=?',
      outputHex32(decisionId)
    )
    if (!row) return undefined
    outputAssert(typeof row.rule === 'string', 'Invalid retained local rule', 'unavailable')
    const rule = this.descriptor(parseOutputJSON(row.rule, { bytes: 16384 }))
    outputAssert(
      canonicalOutputJSON(rule, { bytes: 16384 }) === row.rule && rootBytes(row.rule) === row.bytes,
      'Root local rule record is inconsistent',
      'unavailable'
    )
    return {
      decisionId,
      rule,
      policyDigest: outputHex32(row.policy),
      revision: rootDecimal(row.revision),
      liftedBy: row.lifted_by === null ? null : outputHex32(row.lifted_by)
    }
  }
  private activeWithinGate(): RootEvictionLocalRuleSet {
    const rows = this.database.all(
      'SELECT decision FROM root_local_rules WHERE lifted_by IS NULL ORDER BY decision LIMIT ?',
      this.database.configuration.capacity.blockers + 1
    )
    outputAssert(
      rows.length <= this.database.configuration.capacity.blockers,
      'Root active rule capacity is inconsistent',
      'unavailable'
    )
    return { epoch: this.epoch(), rules: rows.map(row => this.record(outputHex32(row.decision))!) }
  }
  active(
    guard: RootEvictionCommitGuard
  ): Promise<RootEvictionObservation<RootEvictionLocalRuleSet>> {
    return this.work(guard, () => this.activeWithinGate())
  }
  get(
    decisionId: string,
    guard: RootEvictionCommitGuard
  ): Promise<RootEvictionObservation<RootEvictionLocalRuleRecord | undefined>> {
    return this.work(guard, () => this.record(decisionId))
  }
  private operation(
    operationId: string,
    expectedRevision: string,
    semantic: string
  ): { id: string; prior?: string } {
    const id = parseOutputRootEvictionStatus({
      version: 1,
      requester: this.database.configuration.root,
      requestId: operationId
    }).requestId
    outputU64(expectedRevision)
    const previous = this.database.get(
      'SELECT semantic,revision FROM root_assessments WHERE operation_id=?',
      id
    )
    if (previous) {
      outputAssert(
        previous.semantic === semantic,
        'Root local operation conflicts with retained meaning',
        'conflict'
      )
      return { id, prior: rootDecimal(previous.revision) }
    }
    outputAssert(
      this.database.head().revision === expectedRevision,
      'Root local operation lost its decision fence',
      'conflict'
    )
    outputAssert(
      Number(this.database.get('SELECT count(*) AS n FROM root_assessments')!.n) <
        this.database.configuration.capacity.assessments,
      'Root assessment history capacity is full',
      'limited'
    )
    return { id }
  }
  private saveOperation(id: string, semantic: string): string {
    const policy = this.database.head().policyDigest
    const revision = this.database.advance()
    this.database.run(
      'INSERT INTO root_assessments VALUES (?,?,?,?)',
      id,
      semantic,
      policy,
      rootPosition(revision)
    )
    return revision
  }
  private decision(action: 'install' | 'lift', operationId: string, revision: string): string {
    // Local implementation domain, deliberately distinct from the BRC199 peer formula.
    const { root, chain } = this.database.configuration
    const preimage =
      'bsv-root-local-rule/v1\0' +
      canonicalOutputJSON({ action, root, chain, operationId, revision })
    return Utils.toHex(Hash.sha256(Utils.toArray(preimage, 'utf8')))
  }
  private invalidate(revision: string): void {
    this.database.run(
      'UPDATE root_rule_meta SET epoch=? WHERE id=1',
      rootPosition(incrementOutputU64(this.epoch()))
    )
    this.views.invalidate(revision)
  }
  install(
    input: { operationId: string; expectedRevision: string; rule: RootEvictionLocalRule },
    guard: RootEvictionCommitGuard
  ): Promise<RootEvictionObservation<RootEvictionLocalRuleRecord>> {
    return this.work(guard, () => {
      outputAssert(Object.keys(input).length === 3, 'Invalid local rule installation')
      const rule = this.descriptor(input.rule)
      const semantic = canonicalOutputJSON({ kind: 'local-rule-install', rule }, { bytes: 32768 })
      const operation = this.operation(input.operationId, input.expectedRevision, semantic)
      if (operation.prior !== undefined) {
        const saved = this.record(this.decision('install', operation.id, operation.prior))
        outputAssert(saved, 'Root local rule installation record is missing', 'unavailable')
        return saved
      }
      const peerCount = Number(
        this.database.get(`SELECT coalesce(max(n),0) AS n FROM
        (SELECT count(*) AS n FROM root_bases WHERE lifted_by IS NULL GROUP BY target_key)`)!.n
      )
      rootLocalRuleReservation(this.database, peerCount + 1)
      const encoded = canonicalOutputJSON(rule, { bytes: 16384 }),
        bytes = rootBytes(encoded)
      const row = this.database.get(
        'SELECT count(*) AS n,coalesce(sum(bytes),0) AS bytes FROM root_local_rules'
      )!
      const limits = this.database.configuration.localRules!
      outputAssert(
        Number(row.n) < limits.rules && Number(row.bytes) + bytes <= limits.bytes,
        'Root local-rule history capacity is full',
        'limited'
      )
      const revision = this.saveOperation(operation.id, semantic)
      const decisionId = this.decision('install', operation.id, revision)
      this.database.run(
        'INSERT INTO root_local_rules VALUES (?,?,?,?,?,NULL)',
        decisionId,
        encoded,
        bytes,
        this.database.head().policyDigest,
        rootPosition(revision)
      )
      this.invalidate(revision)
      return this.record(decisionId)!
    })
  }
  lift(
    input: {
      operationId: string
      expectedRevision: string
      decisionId: string
      operator: string
      supportingDigest: string
    },
    guard: RootEvictionCommitGuard
  ): Promise<
    RootEvictionObservation<{
      actionStatus: 'applied' | 'no-op'
      decisionId?: string
      affected: string
    }>
  > {
    return this.work(guard, () => {
      outputAssert(Object.keys(input).length === 5, 'Invalid local rule lifting')
      const affected = outputHex32(input.decisionId)
      const semantic = canonicalOutputJSON({
        kind: 'local-rule-lift',
        affected,
        operator: outputIdentity(input.operator),
        supportingDigest: outputHex32(input.supportingDigest)
      })
      const operation = this.operation(input.operationId, input.expectedRevision, semantic)
      const rule = this.record(affected)
      outputAssert(rule, 'Root local rule is not retained', 'not-found')
      const revision = operation.prior ?? this.saveOperation(operation.id, semantic)
      const decisionId = this.decision('lift', operation.id, revision)
      if (operation.prior === undefined && rule.liftedBy === null) {
        this.database.run(
          'UPDATE root_local_rules SET lifted_by=? WHERE decision=?',
          decisionId,
          affected
        )
        this.invalidate(revision)
        return { actionStatus: 'applied' as const, decisionId, affected }
      }
      return rule.liftedBy === decisionId
        ? { actionStatus: 'applied' as const, decisionId, affected }
        : { actionStatus: 'no-op' as const, affected }
    })
  }
  assess(
    input: RootEvictionLocalRuleAssessment,
    guard: RootEvictionCommitGuard
  ): Promise<RootEvictionObservation<string>> {
    return this.work(guard, () => {
      const owned = parseOutputJSON(
        canonicalOutputJSON(input, { bytes: 65536 })
      ) as unknown as RootEvictionLocalRuleAssessment
      outputAssert(
        Object.keys(owned).length === 8 &&
          typeof owned.eligible === 'boolean' &&
          Array.isArray(owned.matches) &&
          owned.matches.length <= this.database.configuration.capacity.blockers,
        'Invalid root local-rule assessment'
      )
      const target = rootTarget(owned.target)
      outputAssert(
        canonicalOutputJSON(target.outpoint.chain) ===
          canonicalOutputJSON(this.database.configuration.chain),
        'Root rule assessment uses another chain'
      )
      outputU64(owned.ruleEpoch)
      let previous = ''
      for (const match of owned.matches) {
        outputAssert(
          Object.keys(match).length === 2 &&
            (match.matches === null || typeof match.matches === 'boolean') &&
            outputHex32(match.decisionId) > previous,
          'Invalid or duplicate root rule match'
        )
        previous = match.decisionId
      }
      const semantic = canonicalOutputJSON(
        {
          kind: 'local-rule-assess',
          target,
          ruleEpoch: owned.ruleEpoch,
          eligible: owned.eligible,
          evidenceDigest: outputHex32(owned.evidenceDigest),
          reasonCode: outputString(owned.reasonCode),
          matches: owned.matches
        },
        { bytes: 65536 }
      )
      const operation = this.operation(owned.operationId, owned.expectedRevision, semantic)
      if (operation.prior !== undefined) return operation.prior
      const active = this.activeWithinGate()
      outputAssert(
        owned.ruleEpoch === active.epoch,
        'Root rule assessment epoch changed',
        'context-changed'
      )
      outputAssert(
        owned.matches.length === active.rules.length &&
          owned.matches.every(
            (match, index) => match.decisionId === active.rules[index].decisionId
          ),
        'Root assessment must account for every active local rule',
        'context-changed'
      )
      const revision = this.saveOperation(operation.id, semantic)
      const complete = owned.matches.every(match => match.matches !== null)
      // First stage materializes the target and never grants eligibility. Bindings
      // are replaced atomically with its complete, retained assessment below.
      this.views.stage(target, false, revision)
      const key = rootTargetKey(target)
      this.database.run('DELETE FROM root_rule_bindings WHERE target_key=?', key)
      for (const match of owned.matches)
        if (match.matches === true)
          this.database.run('INSERT INTO root_rule_bindings VALUES (?,?)', key, match.decisionId)
      this.views.stage(
        target,
        owned.eligible && complete,
        revision,
        complete ? owned.ruleEpoch : undefined
      )
      return revision
    })
  }
  close(): Promise<void> {
    return synchronousPromise(() => this.database.close())
  }
}
