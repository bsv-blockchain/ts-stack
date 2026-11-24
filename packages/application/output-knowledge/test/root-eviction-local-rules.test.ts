import { expect, it, jest } from '@jest/globals'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { canonicalOutputJSON } from '@bsv/sdk'
import { SQLiteRootEvictionStore } from '../src/root-eviction/SQLiteRootEvictionStore.js'
import { SQLiteRootEvictionLocalRules } from '../src/root-eviction/SQLiteRootEvictionLocalRules.js'
import { SQLiteRootEvictionDatabase } from '../src/root-eviction/SQLiteRootEvictionDatabase.js'
import { rootLocalRuleReservation } from '../src/root-eviction/RootEvictionLocalRuleSchema.js'
import { rootConfiguration } from '../src/root-eviction/RootEvictionCodec.js'
import {
  apply,
  chain,
  clock,
  fixture,
  policy,
  request,
  requester,
  restore,
  root,
  selected,
  signed
} from './root-eviction-fixture.js'
import { coordinationGuard } from './root-eviction-coordination-fixture.js'
import { localRule, localRulesFixture } from './root-eviction-local-rules-fixture.js'

const error = (code: string) => ({ code, message: expect.stringMatching(/\S/) })
function query(path: string, sql: string) {
  const db = new DatabaseSync(path)
  try {
    return db.prepare(sql).all()
  } finally {
    db.close()
  }
}
function execute(path: string, sql: string) {
  const db = new DatabaseSync(path)
  try {
    db.exec(sql)
  } finally {
    db.close()
  }
}

it('seals an explicit bounded format3 while retaining exact format1 and format2 configurations', () => {
  const base = { root, chain }
  expect(JSON.parse(rootConfiguration(base).seal).format).toBe('root-eviction/1')
  expect(JSON.parse(rootConfiguration({ ...base, coordination: {} }).seal).format).toBe(
    'root-eviction/2'
  )
  const current = rootConfiguration({ ...base, coordination: {}, localRules: {} })
  expect(current.localRules).toEqual({ rules: 4096, bytes: 67108864 })
  expect(Object.isFrozen(current.localRules)).toBe(true)
  expect(JSON.parse(current.seal).format).toBe('root-eviction/3')
  for (const input of [
    { ...base, localRules: {} },
    ...[
      { rules: 0 },
      { rules: 4097 },
      { rules: 1.5 },
      { bytes: 0 },
      { bytes: 67108865 },
      { bytes: 1.5 },
      { extra: 1 }
    ].map(localRules => ({ ...base, coordination: {}, localRules }))
  ])
    expect(() => rootConfiguration(input)).toThrow()
  expect(
    rootConfiguration({ ...base, coordination: {}, localRules: { rules: 1, bytes: 1 } }).localRules
  ).toEqual({ rules: 1, bytes: 1 })
})

it('requires complete empty-set assessment and projection before serving; legacy assessments cannot bypass format3', async () => {
  const f = await localRulesFixture()
  try {
    expect((await f.rules.active(f.guard)).value).toEqual({ epoch: '0', rules: [] })
    const assessment = {
      operationId: f.nextId(),
      expectedRevision: '0',
      target: selected(),
      eligible: true,
      evidenceDigest: 'bb'.repeat(32),
      reasonCode: 'legacy'
    }
    await f.store.assess(assessment)
    expect((await f.store.projections(64))[0].membership).toBe('withdraw')
    await f.project()
    expect((await f.store.serving(selected())).state).toBe('unresolved')
    await f.assess([])
    expect((await f.store.serving(selected())).state).toBe('unresolved')
    await f.project()
    expect((await f.store.serving(selected())).state).toBe('eligible')
    await f.store.assessChecked(
      { ...assessment, operationId: f.nextId(), expectedRevision: (await f.store.head()).revision },
      f.guard
    )
    await f.project()
    expect((await f.store.serving(selected())).state).toBe('unresolved')
  } finally {
    await f.cleanup()
  }
})

it('retains immutable local attribution and operation fences across restart without fabricating peer requests', async () => {
  const f = await localRulesFixture()
  try {
    const input = { operationId: f.nextId(), expectedRevision: '0', rule: localRule() }
    const saved = structuredClone(input)
    const first = await f.rules.install(input, f.guard)
    const decision = createHash('sha256')
      .update(
        'bsv-root-local-rule/v1\0' +
          canonicalOutputJSON({
            action: 'install',
            root,
            chain,
            operationId: input.operationId,
            revision: '1'
          })
      )
      .digest('hex')
    expect(first.value).toEqual({
      decisionId: decision,
      rule: input.rule,
      policyDigest: policy,
      revision: '1',
      liftedBy: null
    })
    expect(first.observedAt).toBe('150')
    input.rule.parameters.identity = root
    first.value.rule.id = 'changed'
    const reopened = f.reopenRules()
    expect((await reopened.install(saved, f.guard)).value.rule).toEqual(saved.rule)
    expect((await reopened.active(f.guard)).value).toEqual({
      epoch: '1',
      rules: [
        {
          decisionId: decision,
          rule: saved.rule,
          policyDigest: policy,
          revision: '1',
          liftedBy: null
        }
      ]
    })
    expect(query(f.path, 'SELECT count(*) AS n FROM root_requests')[0].n).toBe(0)
    await expect(reopened.install(input, f.guard)).rejects.toMatchObject(error('conflict'))
    expect((await f.store.head()).revision).toBe('1')
    expect((await reopened.get('ef'.repeat(32), f.guard)).value).toBeUndefined()
  } finally {
    await f.cleanup()
  }
})

it('represents independent broader rules on multiple outputs and lifts one without reviving membership', async () => {
  const f = await localRulesFixture()
  try {
    await f.assess([])
    await f.project()
    const first = await f.install()
    expect((await f.store.serving(selected())).state).toBe('unresolved')
    expect((await f.store.projections(64))[0].membership).toBe('withdraw')
    const second = await f.install({ ...localRule(), id: 'urn:test:domain:1' })
    await f.assess([true, true])
    await f.project()
    const blockers = [first.value, second.value]
      .map(rule => ({ decisionId: rule.decisionId, policyDigest: policy }))
      .sort((a, b) => a.decisionId.localeCompare(b.decisionId))
    expect(await f.store.serving(selected())).toMatchObject({ state: 'suppressed', blockers })
    const another = selected(request())
    another.outpoint.outputIndex = 1
    await f.assess([true, true], another)
    await f.project()
    expect((await f.store.serving(another)).blockers).toEqual(blockers)
    const lift = {
      operationId: f.nextId(),
      expectedRevision: (await f.store.head()).revision,
      decisionId: first.value.decisionId,
      operator: requester,
      supportingDigest: 'dd'.repeat(32)
    }
    const result = await f.rules.lift(lift, f.guard)
    expect(result.value).toMatchObject({
      actionStatus: 'applied',
      affected: first.value.decisionId,
      decisionId: expect.stringMatching(/^[0-9a-f]{64}$/)
    })
    expect((await f.store.serving(selected())).blockers).toEqual([
      { decisionId: second.value.decisionId, policyDigest: policy }
    ])
    expect((await f.rules.lift(lift, f.guard)).value).toEqual(result.value)
    const noOp = await f.rules.lift(
      { ...lift, operationId: f.nextId(), expectedRevision: (await f.store.head()).revision },
      f.guard
    )
    expect(noOp.value).toEqual({ actionStatus: 'no-op', affected: first.value.decisionId })
    await f.rules.lift(
      {
        ...lift,
        operationId: f.nextId(),
        expectedRevision: (await f.store.head()).revision,
        decisionId: second.value.decisionId
      },
      f.guard
    )
    await f.project()
    expect((await f.store.serving(selected())).state).toBe('unresolved')
    await f.assess([])
    await f.project()
    expect((await f.store.serving(selected())).state).toBe('eligible')
    expect((await f.store.serving(another)).state).toBe('unresolved')
  } finally {
    await f.cleanup()
  }
})

it('keeps a local blocker after peer restoration and keeps a peer blocker after a local lift', async () => {
  const f = await localRulesFixture()
  try {
    const rule = await f.install()
    const suppression = await apply(f.store)
    const peer = suppression.outcomes[0].decisionId!
    await f.assess([true])
    await f.project()
    const restored = await apply(f.store, restore('peer_restore_operation', peer))
    expect(restored.outcomes[0]).toMatchObject({
      actionStatus: 'applied',
      serving: {
        state: 'suppressed',
        blockers: [{ decisionId: rule.value.decisionId, policyDigest: policy }]
      }
    })
    const again = await apply(f.store, request('another_peer_suppression'))
    await f.rules.lift(
      {
        operationId: f.nextId(),
        expectedRevision: (await f.store.head()).revision,
        decisionId: rule.value.decisionId,
        operator: requester,
        supportingDigest: 'dd'.repeat(32)
      },
      f.guard
    )
    expect((await f.store.serving(selected())).blockers).toEqual([
      { decisionId: again.outcomes[0].decisionId, policyDigest: policy }
    ])
  } finally {
    await f.cleanup()
  }
})

it('keeps unknown rules unresolved, records known blockers, and requires independently positive currentness', async () => {
  const f = await localRulesFixture()
  try {
    await f.install()
    await f.install({ ...localRule(), id: 'urn:test:unknown:1' })
    await f.assess([false, null])
    await f.project()
    expect(await f.store.serving(selected())).toMatchObject({ state: 'unresolved', blockers: [] })
    await f.assess([true, null])
    await f.project()
    expect((await f.store.serving(selected())).state).toBe('suppressed')
    await f.assess([false, false], selected(), false)
    await f.project()
    expect((await f.store.serving(selected())).state).toBe('unresolved')
    await f.assess([false, false])
    await f.project()
    expect((await f.store.serving(selected())).state).toBe('eligible')
    const before = await f.assess([false, false])
    await f.project()
    await f.install({ ...localRule(), id: 'urn:test:new:1' })
    await expect(
      f.rules.assess(
        {
          ...before.input,
          operationId: f.nextId(),
          expectedRevision: (await f.store.head()).revision
        },
        f.guard
      )
    ).rejects.toMatchObject(error('context-changed'))
    expect((await f.store.serving(selected())).state).toBe('unresolved')
    expect((await f.rules.assess(before.input, f.guard)).value).toBe(before.result.value)
    expect((await f.store.serving(selected())).state).toBe('unresolved')
  } finally {
    await f.cleanup()
  }
})

it('rejects incomplete, foreign, duplicate and reordered coverage atomically', async () => {
  const f = await localRulesFixture()
  try {
    await f.install()
    await f.install({ ...localRule(), id: 'urn:test:second:1' })
    const base = (await f.assess([false, false])).input
    const head = await f.store.head()
    for (const matches of [
      [],
      base.matches.slice(0, 1),
      [...base.matches].reverse(),
      [base.matches[0], base.matches[0]],
      [{ decisionId: 'ff'.repeat(32), matches: false }]
    ]) {
      await expect(
        f.rules.assess(
          { ...base, operationId: f.nextId(), expectedRevision: head.revision, matches },
          f.guard
        )
      ).rejects.toMatchObject({ message: expect.stringMatching(/\S/) })
      expect(await f.store.head()).toEqual(head)
    }
    await expect(
      f.rules.assess(
        {
          ...base,
          operationId: f.nextId(),
          expectedRevision: head.revision,
          target: {
            ...selected(),
            outpoint: { ...selected().outpoint, chain: { ...chain, network: 'other' } }
          }
        },
        f.guard
      )
    ).rejects.toMatchObject(error('invalid'))
  } finally {
    await f.cleanup()
  }
})

it('reserves all active rules plus peer bases, even when the rule does not match the current output', async () => {
  const f = await localRulesFixture({ capacity: { blockers: 2 } })
  try {
    await f.install()
    await f.assess([false])
    await f.project()
    await apply(f.store)
    const before = await f.store.head()
    await expect(f.install({ ...localRule(), id: 'urn:test:capacity:1' })).rejects.toMatchObject(
      error('limited')
    )
    expect(await f.store.head()).toEqual(before)
    const pending = await f.store.retain(signed(request('over_capacity_peer')), requester, clock)
    const retained = await f.store.head()
    await expect(
      f.store.evaluate({
        requestDigest: pending.digest,
        expectedRevision: retained.revision,
        now: clock.now,
        targets: [{ index: 0, disposition: 'accept', reasonCode: 'reviewed', eligible: true }]
      })
    ).rejects.toMatchObject(error('limited'))
    expect(await f.store.head()).toEqual(retained)
    expect(
      (await f.store.result(requester, 'over_capacity_peer', clock.now)).outcomes[0].actionStatus
    ).toBe('pending')
  } finally {
    await f.cleanup()
  }
})

it('bounds immutable rule bytes and retained history before effects and never reuses lifted history capacity', async () => {
  const bytes = Buffer.byteLength(canonicalOutputJSON(localRule()))
  const f = await localRulesFixture({ localRules: { rules: 1, bytes } })
  try {
    const saved = await f.install()
    expect((await f.rules.get(saved.value.decisionId, f.guard)).value).toEqual(saved.value)
    const before = await f.store.head()
    await expect(f.install()).rejects.toMatchObject(error('limited'))
    expect(await f.store.head()).toEqual(before)
    await f.rules.lift(
      {
        operationId: f.nextId(),
        expectedRevision: before.revision,
        decisionId: saved.value.decisionId,
        operator: requester,
        supportingDigest: 'dd'.repeat(32)
      },
      f.guard
    )
    await expect(f.install()).rejects.toMatchObject(error('limited'))
  } finally {
    await f.cleanup()
  }
  const short = await localRulesFixture({ localRules: { bytes: bytes - 1 } })
  try {
    await expect(short.install()).rejects.toMatchObject(error('limited'))
    expect((await short.store.head()).revision).toBe('0')
  } finally {
    await short.cleanup()
  }
})

it('reserves permanent lift history before install and protects it from ordinary assessments', async () => {
  const small = await localRulesFixture({ capacity: { assessments: 1 } })
  try {
    await expect(small.install()).rejects.toMatchObject(error('limited'))
    expect((await small.store.head()).revision).toBe('0')
  } finally {
    await small.cleanup()
  }
  const f = await localRulesFixture({ capacity: { assessments: 2 } })
  try {
    const installed = await f.install()
    await expect(f.assess([false])).rejects.toMatchObject(error('limited'))
    await expect(
      f.store.assess({
        operationId: f.nextId(),
        expectedRevision: (await f.store.head()).revision,
        target: selected(),
        eligible: false,
        evidenceDigest: 'bb'.repeat(32),
        reasonCode: 'ordinary'
      })
    ).rejects.toMatchObject(error('limited'))
    const lifted = await f.rules.lift(
      {
        operationId: f.nextId(),
        expectedRevision: (await f.store.head()).revision,
        decisionId: installed.value.decisionId,
        operator: requester,
        supportingDigest: 'dd'.repeat(32)
      },
      f.guard
    )
    expect(lifted.value.actionStatus).toBe('applied')
    expect((await f.rules.active(f.guard)).value.rules).toHaveLength(0)
    await expect(f.assess([])).rejects.toMatchObject(error('limited'))
  } finally {
    await f.cleanup()
  }
})

it('checks current access, policy, context and revision under the actual gate', async () => {
  const f = await localRulesFixture()
  try {
    const input = { operationId: f.nextId(), expectedRevision: '0', rule: localRule() }
    for (const [guard, code] of [
      [{ ...f.guard, authorize: () => false }, 'not-found'],
      [{ ...f.guard, contextCurrent: () => false }, 'context-changed'],
      [{ ...f.guard, expectedPolicyDigest: 'ee'.repeat(32) }, 'context-changed']
    ] as const) {
      await expect(f.rules.install(input, guard)).rejects.toMatchObject(error(code))
      await expect(f.rules.get('ff'.repeat(32), guard)).rejects.toMatchObject(error(code))
      await expect(f.rules.active(guard)).rejects.toMatchObject(error(code))
    }
    await expect(
      f.rules.install({ ...input, expectedRevision: '1' }, f.guard)
    ).rejects.toMatchObject(error('conflict'))
    await expect(
      f.rules.lift(
        {
          operationId: f.nextId(),
          expectedRevision: '0',
          decisionId: 'ff'.repeat(32),
          operator: requester,
          supportingDigest: 'dd'.repeat(32)
        },
        f.guard
      )
    ).rejects.toMatchObject(error('not-found'))
    expect((await f.store.head()).revision).toBe('0')
  } finally {
    await f.cleanup()
  }
})

it('fences hydrated sends and stale projection acknowledgements after rule installation', async () => {
  const f = await localRulesFixture()
  try {
    await f.assess([])
    const intent = (await f.store.projections(64))[0]
    await f.project()
    const head = await f.store.head()
    await f.install()
    expect(await f.store.projected(intent)).toBe(false)
    const send = jest.fn<(_bytes: Uint8Array) => undefined>(() => undefined)
    await expect(
      f.store.enqueue(
        { revision: head.revision, targets: [selected()], bytes: Uint8Array.of(1) },
        () => true,
        send
      )
    ).rejects.toMatchObject(error('reset-required'))
    await expect(
      f.store.enqueue(
        {
          revision: (await f.store.head()).revision,
          targets: [selected()],
          bytes: Uint8Array.of(1)
        },
        () => true,
        send
      )
    ).rejects.toMatchObject(error('reset-required'))
    expect(send).not.toHaveBeenCalled()
  } finally {
    await f.cleanup()
  }
})

it('explicitly upgrades format2, preserves prior records, invalidates views and fences older live connections', async () => {
  const f = await fixture({ coordination: {} })
  let upgraded: SQLiteRootEvictionStore | undefined
  try {
    const old = f.reopen()
    await apply(f.store)
    const retained = Object.fromEntries(
      ['root_requests', 'root_actions', 'root_bases', 'root_assessments'].map(table => [
        table,
        query(f.path, `SELECT * FROM ${table}`)
      ])
    )
    const configuration = { ...f.configuration, localRules: {} }
    expect(() => SQLiteRootEvictionStore.open(f.path, configuration)).toThrow(
      'configuration changed'
    )
    upgraded = SQLiteRootEvictionStore.upgradeLocalRules(f.path, configuration)
    expect(await upgraded.projections(64)).toMatchObject([{ membership: 'withdraw' }])
    for (const [table, rows] of Object.entries(retained))
      expect(query(f.path, `SELECT * FROM ${table}`)).toEqual(rows)
    await expect(old.head()).rejects.toMatchObject(error('context-changed'))
    await expect(old.serving(selected())).rejects.toMatchObject(error('context-changed'))
    const retry = SQLiteRootEvictionStore.upgradeLocalRules(f.path, configuration)
    expect(await retry.head()).toEqual(await upgraded.head())
    await retry.close()
    const rules = SQLiteRootEvictionLocalRules.open(f.path, configuration)
    expect((await rules.active(coordinationGuard())).value).toEqual({ epoch: '0', rules: [] })
    await rules.close()
  } finally {
    await upgraded?.close()
    await f.cleanup()
  }
})

it('does not implicitly upgrade format1, recreate missing local history, or accept mismatched migration configuration', async () => {
  const old = await fixture()
  try {
    const configuration = { ...old.configuration, coordination: {}, localRules: {} }
    expect(() => SQLiteRootEvictionStore.upgradeLocalRules(old.path, configuration)).toThrow(
      'original coordinated configuration'
    )
    expect(() => SQLiteRootEvictionStore.upgradeCoordination(old.path, configuration)).toThrow(
      'explicit configuration'
    )
    expect((await old.store.head()).revision).toBe('0')
    expect(() => SQLiteRootEvictionLocalRules.open(old.path, old.configuration)).toThrow(
      'explicit format3'
    )
  } finally {
    await old.cleanup()
  }
  const f = await localRulesFixture()
  try {
    expect(() =>
      SQLiteRootEvictionStore.upgradeLocalRules(f.path, {
        ...f.configuration,
        localRules: { rules: 1 }
      })
    ).toThrow('original coordinated configuration')
    execute(f.path, 'DROP TABLE root_rule_coverage')
    expect(() => SQLiteRootEvictionStore.open(f.path, f.configuration)).toThrow()
  } finally {
    await f.cleanup()
  }
})

it('rolls back an exhausted migration and exhausted rule epoch without changing history', async () => {
  const f = await fixture({ coordination: {} })
  try {
    execute(f.path, "UPDATE root_meta SET revision='ffffffffffffffff'")
    expect(() =>
      SQLiteRootEvictionStore.upgradeLocalRules(f.path, { ...f.configuration, localRules: {} })
    ).toThrow()
    expect((await f.store.head()).revision).toBe('18446744073709551615')
    expect(query(f.path, "SELECT name FROM sqlite_master WHERE name='root_local_rules'")).toEqual(
      []
    )
  } finally {
    await f.cleanup()
  }
  const g = await localRulesFixture()
  try {
    execute(g.path, "UPDATE root_rule_meta SET epoch='ffffffffffffffff'")
    await expect(g.install()).rejects.toMatchObject(error('limited'))
    expect((await g.store.head()).revision).toBe('0')
    expect(query(g.path, 'SELECT * FROM root_local_rules')).toEqual([])
    expect(query(g.path, 'SELECT * FROM root_assessments')).toEqual([])
  } finally {
    await g.cleanup()
  }
})

it('rejects malformed descriptors and changed install/lift/assessment meanings without consuming capacity', async () => {
  const f = await localRulesFixture()
  try {
    for (const rule of [
      { ...localRule(), id: '' },
      { ...localRule(), parameters: [] },
      { ...localRule(), parameters: null },
      { ...localRule(), supportingDigest: 'bad' },
      { ...localRule(), operator: 'bad' },
      { ...localRule(), extra: true }
    ]) {
      await expect(
        f.rules.install(
          {
            operationId: f.nextId(),
            expectedRevision: '0',
            rule: rule as ReturnType<typeof localRule>
          },
          f.guard
        )
      ).rejects.toMatchObject(error('invalid'))
      expect((await f.store.head()).revision).toBe('0')
    }
    await expect(
      f.rules.install(
        {
          operationId: f.nextId(),
          expectedRevision: '0',
          rule: { ...localRule(), parameters: { oversized: 'x'.repeat(16384) } }
        },
        f.guard
      )
    ).rejects.toMatchObject(error('limited'))
    const installed = await f.install()
    const assessed = await f.assess([false])
    await expect(
      f.rules.assess({ ...assessed.input, evidenceDigest: 'ef'.repeat(32) }, f.guard)
    ).rejects.toMatchObject(error('conflict'))
    const input = {
      operationId: f.nextId(),
      expectedRevision: (await f.store.head()).revision,
      decisionId: installed.value.decisionId,
      operator: requester,
      supportingDigest: 'dd'.repeat(32)
    }
    const lifted = await f.rules.lift(input, f.guard)
    await expect(
      f.rules.lift({ ...input, supportingDigest: 'ef'.repeat(32) }, f.guard)
    ).rejects.toMatchObject(error('conflict'))
    await expect(
      f.rules.install(
        {
          operationId: input.operationId,
          expectedRevision: lifted.head.revision,
          rule: localRule()
        },
        f.guard
      )
    ).rejects.toMatchObject(error('conflict'))
    expect(
      (
        await f.rules.install(
          {
            operationId: f.nextId(),
            expectedRevision: lifted.head.revision,
            rule: localRule()
          },
          f.guard
        )
      ).value.rule
    ).toEqual(localRule())
  } finally {
    await f.cleanup()
  }
})

it('does not carry local-rule eligibility across a root policy rotation and retains the original blocker policy', async () => {
  const f = await localRulesFixture()
  try {
    const installed = await f.install()
    await f.assess([true])
    await f.project()
    const nextPolicy = 'ee'.repeat(32)
    await f.store.changePolicy(nextPolicy)
    expect((await f.store.serving(selected())).blockers).toEqual([
      { decisionId: installed.value.decisionId, policyDigest: policy }
    ])
    await expect(f.rules.active(f.guard)).rejects.toMatchObject(error('context-changed'))
    const nextGuard = { ...f.guard, expectedPolicyDigest: nextPolicy }
    const active = await f.rules.active(nextGuard)
    await f.rules.assess(
      {
        operationId: f.nextId(),
        expectedRevision: active.head.revision,
        ruleEpoch: active.value.epoch,
        target: selected(),
        eligible: true,
        evidenceDigest: 'bb'.repeat(32),
        reasonCode: 'new-context',
        matches: [{ decisionId: installed.value.decisionId, matches: false }]
      },
      nextGuard
    )
    await f.project()
    expect((await f.store.serving(selected())).state).toBe('eligible')
    await f.store.changePolicy('aa'.repeat(32))
    await f.project()
    expect((await f.store.serving(selected())).state).toBe('unresolved')
  } finally {
    await f.cleanup()
  }
})

it('refuses inconsistent retained rule bytes and invalid coverage on reopen', async () => {
  const f = await localRulesFixture()
  try {
    const installed = await f.install()
    execute(f.path, 'UPDATE root_local_rules SET bytes=bytes+1')
    await expect(f.rules.get(installed.value.decisionId, f.guard)).rejects.toMatchObject(
      error('unavailable')
    )
    expect(() => SQLiteRootEvictionStore.open(f.path, f.configuration)).toThrow(
      'history accounting'
    )
    execute(f.path, 'UPDATE root_local_rules SET bytes=bytes-1')
    await f.assess([false])
    await f.project()
    execute(f.path, "UPDATE root_rule_coverage SET epoch='0000000000000002'")
    expect((await f.store.serving(selected())).state).toBe('unresolved')
    expect(() => SQLiteRootEvictionStore.open(f.path, f.configuration)).toThrow(
      'coverage accounting'
    )
  } finally {
    await f.cleanup()
  }
})

it('leaves ordinary format1 reservation callers unchanged', async () => {
  const f = await fixture()
  const database = new SQLiteRootEvictionDatabase(f.path, f.configuration, undefined)
  try {
    expect(database.transaction(() => rootLocalRuleReservation(database, 64))).toBeUndefined()
    expect((await f.store.head()).revision).toBe('0')
  } finally {
    database.close()
    await f.cleanup()
  }
})

it('reserves future lift epochs and projection revisions before accepting new local work', async () => {
  const f = await localRulesFixture()
  try {
    execute(f.path, "UPDATE root_rule_meta SET epoch='fffffffffffffffe'")
    await expect(f.install()).rejects.toMatchObject(error('limited'))
    expect((await f.store.head()).revision).toBe('0')
    execute(f.path, "UPDATE root_rule_meta SET epoch='0000000000000000'")
    await f.assess([])
    await f.project()
    execute(f.path, "UPDATE root_meta SET revision='fffffffffffffffc'")
    const before = await f.store.head()
    await expect(f.install()).rejects.toMatchObject(error('limited'))
    expect(await f.store.head()).toEqual(before)
    expect((await f.rules.active(f.guard)).value.rules).toEqual([])
  } finally {
    await f.cleanup()
  }
})

it('rejects surplus local operation fields and non-object rule parameters before effects', async () => {
  const f = await localRulesFixture()
  try {
    await expect(
      f.rules.install(
        {
          operationId: f.nextId(),
          expectedRevision: '0',
          rule: localRule(),
          extra: true
        } as Parameters<typeof f.rules.install>[0],
        f.guard
      )
    ).rejects.toMatchObject(error('invalid'))
    await expect(
      f.rules.install(
        {
          operationId: f.nextId(),
          expectedRevision: '0',
          rule: { ...localRule(), parameters: 'text' as never }
        },
        f.guard
      )
    ).rejects.toMatchObject(error('invalid'))
    const installed = await f.install()
    const head = await f.store.head()
    await expect(
      f.rules.lift(
        {
          operationId: f.nextId(),
          expectedRevision: head.revision,
          decisionId: installed.value.decisionId,
          operator: requester,
          supportingDigest: 'dd'.repeat(32),
          extra: true
        } as Parameters<typeof f.rules.lift>[0],
        f.guard
      )
    ).rejects.toMatchObject(error('invalid'))
    expect(await f.store.head()).toEqual(head)
  } finally {
    await f.cleanup()
  }
})

it('requires closed assessment fields, boolean eligibility and tri-state matches before changing serving state', async () => {
  const f = await localRulesFixture()
  try {
    await f.install()
    const assessed = await f.assess([false])
    await f.project()
    const head = await f.store.head()
    for (const change of [
      { extra: true },
      { eligible: 1 },
      { eligible: 'true' },
      { matches: null },
      { matches: {} },
      { matches: [{ ...assessed.input.matches[0], extra: true }] },
      { matches: [{ ...assessed.input.matches[0], matches: 1 }] },
      { matches: [{ ...assessed.input.matches[0], matches: 'false' }] }
    ]) {
      const input = {
        ...assessed.input,
        operationId: f.nextId(),
        expectedRevision: head.revision,
        ...change
      }
      await expect(
        f.rules.assess(input as Parameters<typeof f.rules.assess>[0], f.guard)
      ).rejects.toMatchObject(error('invalid'))
      expect(await f.store.head()).toEqual(head)
      expect((await f.store.serving(selected())).state).toBe('eligible')
    }
    await expect(
      f.rules.assess(
        {
          ...assessed.input,
          operationId: f.nextId(),
          expectedRevision: head.revision,
          ruleEpoch: '999'
        },
        f.guard
      )
    ).rejects.toMatchObject(error('context-changed'))
  } finally {
    await f.cleanup()
  }
})

it('rejects duplicate and foreign coverage with precise shape-versus-inventory refusal', async () => {
  const f = await localRulesFixture()
  try {
    await f.install()
    await f.install({ ...localRule(), id: 'urn:test:other:1' })
    const assessed = await f.assess([false, false])
    const head = await f.store.head()
    const matches = [assessed.input.matches[0], assessed.input.matches[0]]
    await expect(
      f.rules.assess(
        { ...assessed.input, operationId: f.nextId(), expectedRevision: head.revision, matches },
        f.guard
      )
    ).rejects.toMatchObject(error('invalid'))
    await expect(
      f.rules.assess(
        {
          ...assessed.input,
          operationId: f.nextId(),
          expectedRevision: head.revision,
          matches: [...assessed.input.matches].reverse()
        },
        f.guard
      )
    ).rejects.toMatchObject(error('invalid'))
    await expect(
      f.rules.assess(
        {
          ...assessed.input,
          operationId: f.nextId(),
          expectedRevision: head.revision,
          matches: [
            { decisionId: '00'.repeat(32), matches: false },
            { decisionId: 'ff'.repeat(32), matches: false }
          ]
        },
        f.guard
      )
    ).rejects.toMatchObject(error('context-changed'))
    expect(await f.store.head()).toEqual(head)
  } finally {
    await f.cleanup()
  }
})

it('accepts complete coverage exactly at the blocker ceiling and rejects overlong inputs', async () => {
  const f = await localRulesFixture({ capacity: { blockers: 2 } })
  try {
    await f.install()
    await f.install({ ...localRule(), id: 'urn:test:second:1' })
    const active = await f.rules.active(f.guard)
    expect(active.value.rules).toHaveLength(2)
    const assessed = await f.assess([false, false])
    await f.project()
    expect((await f.store.serving(selected())).state).toBe('eligible')
    await expect(
      f.rules.assess(
        {
          ...assessed.input,
          operationId: f.nextId(),
          expectedRevision: (await f.store.head()).revision,
          matches: [...assessed.input.matches, { decisionId: 'ff'.repeat(32), matches: false }]
        },
        f.guard
      )
    ).rejects.toMatchObject(error('invalid'))
  } finally {
    await f.cleanup()
  }
})

it('retains distinct canonical operation namespaces and makes a repeated lift completely effect-free', async () => {
  const f = await localRulesFixture()
  try {
    const installed = await f.install()
    await f.assess([true])
    const input = {
      operationId: f.nextId(),
      expectedRevision: (await f.store.head()).revision,
      decisionId: installed.value.decisionId,
      operator: requester,
      supportingDigest: 'dd'.repeat(32)
    }
    const result = await f.rules.lift(input, f.guard)
    const active = await f.rules.active(f.guard)
    expect(await f.rules.lift(input, f.guard)).toEqual(result)
    expect(await f.rules.active(f.guard)).toEqual(active)
    const kinds = query(f.path, 'SELECT semantic FROM root_assessments ORDER BY revision').map(
      row => JSON.parse(row.semantic as string).kind
    )
    expect(kinds).toEqual(['local-rule-install', 'local-rule-assess', 'local-rule-lift'])
    const expected = createHash('sha256')
      .update(
        'bsv-root-local-rule/v1\0' +
          canonicalOutputJSON({
            action: 'lift',
            root,
            chain,
            operationId: input.operationId,
            revision: result.head.revision
          })
      )
      .digest('hex')
    expect(result.value.decisionId).toBe(expected)
  } finally {
    await f.cleanup()
  }
})

it('recovers at exact history and byte capacity, and refuses over-capacity persisted inventories', async () => {
  const bytes = Buffer.byteLength(canonicalOutputJSON(localRule()))
  for (const localRules of [{ rules: 1 }, { bytes }]) {
    const f = await localRulesFixture({ localRules })
    try {
      await f.install()
      expect((await f.reopenRules().active(f.guard)).value.rules).toHaveLength(1)
      execute(
        f.path,
        `INSERT INTO root_local_rules SELECT '${'ef'.repeat(32)}',rule,bytes,policy,revision,lifted_by FROM root_local_rules LIMIT 1`
      )
      expect(() => f.reopen()).toThrow(expect.objectContaining(error('unavailable')))
    } finally {
      await f.cleanup()
    }
  }
})

it('fails when an original installation record is lost, and closes its owned database connection', async () => {
  const f = await localRulesFixture()
  try {
    const input = { operationId: f.nextId(), expectedRevision: '0', rule: localRule() }
    await f.rules.install(input, f.guard)
    execute(f.path, 'DELETE FROM root_local_rules')
    await expect(f.rules.install(input, f.guard)).rejects.toMatchObject(error('unavailable'))
    const reopened = f.reopenRules()
    await reopened.close()
    await expect(reopened.active(f.guard)).rejects.toMatchObject(error('unavailable'))
    expect((await f.rules.active(f.guard)).value.rules).toEqual([])
  } finally {
    await f.cleanup()
  }
})

it('refuses an inconsistent active inventory before truncating it or returning partial coverage', async () => {
  const f = await localRulesFixture({ capacity: { blockers: 1 } })
  try {
    await f.install()
    execute(
      f.path,
      `INSERT INTO root_local_rules SELECT '${'ef'.repeat(32)}',rule,bytes,policy,revision,lifted_by FROM root_local_rules LIMIT 1`
    )
    await expect(f.rules.active(f.guard)).rejects.toMatchObject(error('unavailable'))
  } finally {
    await f.cleanup()
  }
})
