import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { afterEach, expect, it, jest } from '@jest/globals'
import {
  rootCommitContext,
  type RootEvictionCommitGuard
} from '../src/root-eviction/RootEvictionCommitContext.js'
import {
  fixture,
  request,
  requester,
  policy,
  selected,
  signed,
  clock
} from './root-eviction-fixture.js'

const head = { revision: '0', policyDigest: policy }
const guard = (changes: Partial<RootEvictionCommitGuard> = {}): RootEvictionCommitGuard => ({
  expectedPolicyDigest: policy,
  clock: () => '150',
  authorize: () => true,
  contextCurrent: () => true,
  ...changes
})
const fixtures: Awaited<ReturnType<typeof fixture>>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup()
})
async function make() {
  const f = await fixture()
  fixtures.push(f)
  return f
}

it('samples one clock and supplies an owned immutable head in authorization/context order', () => {
  const order: string[] = []
  const original = { ...head }
  const value = guard({
    clock: () => {
      order.push('clock')
      return '151'
    },
    authorize: (current, now) => {
      order.push('authorize')
      expect(current).toEqual(head)
      expect(current).not.toBe(original)
      expect(Object.isFrozen(current)).toBe(true)
      expect(now).toBe('151')
      return true
    },
    contextCurrent: (current, now) => {
      order.push('context')
      expect(current).toEqual(head)
      expect(Object.isFrozen(current)).toBe(true)
      expect(now).toBe('151')
      return true
    }
  })
  expect(rootCommitContext(original, value)).toBe('151')
  expect(order).toEqual(['clock', 'authorize', 'context'])
  expect(original).toEqual(head)
})
it.each(['clock', 'authorize', 'contextCurrent'] as const)(
  'rejects an async %s before invoking callbacks',
  name => {
    let invoked = false
    const value = guard()
    Reflect.set(value, name, async () => {
      invoked = true
      return true
    })
    expect(() => rootCommitContext(head, value)).toThrow('synchronous local functions')
    expect(invoked).toBe(false)
  }
)
it.each(['clock', 'authorize', 'contextCurrent'] as const)(
  'rejects a missing %s with the local-port diagnostic',
  name => {
    const value = guard()
    Reflect.set(value, name, undefined)
    expect(() => rootCommitContext(head, value)).toThrow('synchronous local functions')
  }
)
it.each(['-1', '01', '18446744073709551616', ''])(
  'rejects an invalid clock %s before authorization',
  now => {
    const authorize = jest.fn(() => true)
    expect(() => rootCommitContext(head, guard({ clock: () => now, authorize }))).toThrow()
    expect(authorize).not.toHaveBeenCalled()
  }
)
it.each([false, undefined, 1, 'true', {}])(
  'does not interpret a non-true access result as authorization (%j)',
  value => {
    const contextCurrent = jest.fn(() => true)
    expect(() =>
      rootCommitContext(
        head,
        guard({
          authorize: () => value as boolean,
          expectedPolicyDigest: '88'.repeat(32),
          contextCurrent
        })
      )
    ).toThrow(
      expect.objectContaining({
        code: 'not-found',
        message: expect.stringContaining('unavailable')
      })
    )
    expect(contextCurrent).not.toHaveBeenCalled()
  }
)
it('checks the installed policy before accepting a captured external context', () => {
  const contextCurrent = jest.fn(() => true)
  expect(() =>
    rootCommitContext(head, guard({ expectedPolicyDigest: '88'.repeat(32), contextCurrent }))
  ).toThrow(
    expect.objectContaining({
      code: 'context-changed',
      message: expect.stringContaining('policy changed')
    })
  )
  expect(contextCurrent).not.toHaveBeenCalled()
})
it.each([false, undefined, 1, 'true', {}])(
  'requires an explicit current-context decision (%j)',
  value => {
    expect(() =>
      rootCommitContext(head, guard({ contextCurrent: () => value as boolean }))
    ).toThrow(
      expect.objectContaining({
        code: 'context-changed',
        message: expect.stringContaining('context changed')
      })
    )
  }
)
it('accepts both finite U64 clock boundaries without implicit numeric rounding', () => {
  for (const now of ['0', '18446744073709551615'])
    expect(rootCommitContext(head, guard({ clock: () => now }))).toBe(now)
})
it('propagates a failed trusted port before evaluating subsequent checks', () => {
  const contextCurrent = jest.fn(() => true)
  const failure = new Error('fixture local port unavailable')
  expect(() =>
    rootCommitContext(
      head,
      guard({
        authorize: () => {
          throw failure
        },
        contextCurrent
      })
    )
  ).toThrow(failure)
  expect(contextCurrent).not.toHaveBeenCalled()
})

it('returns the actual observation head and retains exact retries after expiry', async () => {
  const f = await make(),
    body = request('fixture_checked_retry')
  const first = await f.store.retainChecked(signed(body), requester, clock, guard())
  expect(first).toMatchObject({ head, observedAt: '150', value: { policyDigest: policy } })
  const retry = await f.store.retainChecked(
    signed(body),
    requester,
    clock,
    guard({ clock: () => '201' })
  )
  expect(retry.value).toEqual(first.value)
  const result = await f.store.resultChecked(
    requester,
    body.requestId,
    guard({ clock: () => '201' })
  )
  expect(result.value.outcomes[0]).toMatchObject({
    actionStatus: 'rejected',
    reasonCode: 'request-expired',
    revision: '1'
  })
  expect(result.head).toEqual(await f.store.head())
  expect(result.observedAt).toBe('201')
  expect(result.value.issuedAt).toBe('201')
})
it('retains expiry instead of applying an old decision even when its captured revision is stale', async () => {
  const f = await make(),
    body = request('fixture_checked_expiry')
  const saved = await f.store.retainChecked(signed(body), requester, clock, guard())
  await f.store.assessChecked(
    {
      operationId: 'fixture_checked_assessment',
      expectedRevision: '0',
      target: selected(body),
      eligible: true,
      evidenceDigest: '77'.repeat(32),
      reasonCode: 'verified-local'
    },
    guard()
  )
  const evaluated = await f.store.evaluateChecked(
    {
      requestDigest: saved.value.digest,
      expectedRevision: '0',
      targets: [{ index: 0, disposition: 'accept', reasonCode: 'reviewed', eligible: true }]
    },
    guard({ clock: () => '200' })
  )
  expect(evaluated.value).toBeUndefined()
  expect(evaluated.head).toEqual(await f.store.head())
  expect(
    (await f.store.resultChecked(requester, body.requestId, guard({ clock: () => '200' }))).value
      .outcomes[0]
  ).toMatchObject({ actionStatus: 'rejected', reasonCode: 'request-expired' })
})

it('returns the committed decision head and preserves an assessment retry beneath a later head', async () => {
  const f = await make(),
    body = request('fixture_checked_applied')
  const saved = await f.store.retainChecked(signed(body), requester, clock, guard())
  const applied = await f.store.evaluateChecked(
    {
      requestDigest: saved.value.digest,
      expectedRevision: saved.head.revision,
      targets: [{ index: 0, disposition: 'accept', reasonCode: 'reviewed', eligible: true }]
    },
    guard({ clock: () => '151' })
  )
  expect(applied).toEqual({
    value: undefined,
    head: { policyDigest: policy, revision: '1' },
    observedAt: '151'
  })
  const result = await f.store.resultChecked(
    requester,
    body.requestId,
    guard({ clock: () => '152' })
  )
  expect(result.head).toEqual(applied.head)
  expect(result.value.outcomes[0]).toMatchObject({
    actionStatus: 'applied',
    revision: '1',
    serving: { state: 'suppressed' }
  })
  const input = {
    operationId: 'fixture_checked_reassessment',
    expectedRevision: '1',
    target: selected(body),
    eligible: false,
    evidenceDigest: '77'.repeat(32),
    reasonCode: 'verified-local'
  }
  expect(await f.store.assessChecked(input, guard({ clock: () => '153' }))).toEqual({
    value: '2',
    head: { policyDigest: policy, revision: '2' },
    observedAt: '153'
  })
  await f.store.projected((await f.store.projections(1))[0])
  expect(await f.store.assessChecked(input, guard({ clock: () => '154' }))).toEqual({
    value: '2',
    head: { policyDigest: policy, revision: '3' },
    observedAt: '154'
  })
})
it.each(['retain', 'evaluate', 'assess', 'result'])(
  'rechecks current access before %s effects or record disclosure',
  async operation => {
    const f = await make(),
      body = request('fixture_checked_denied')
    const before = await f.store.head()
    const denied = guard({ authorize: () => false })
    const work =
      operation === 'retain'
        ? f.store.retainChecked(signed(body), requester, clock, denied)
        : operation === 'evaluate'
          ? f.store.evaluateChecked(
              { requestDigest: '88'.repeat(32), expectedRevision: '0', targets: [] },
              denied
            )
          : operation === 'assess'
            ? f.store.assessChecked(
                {
                  operationId: 'fixture_checked_denied_assessment',
                  expectedRevision: '0',
                  target: selected(body),
                  eligible: true,
                  evidenceDigest: '77'.repeat(32),
                  reasonCode: 'verified-local'
                },
                denied
              )
            : f.store.resultChecked(requester, body.requestId, denied)
    await expect(work).rejects.toMatchObject({ code: 'not-found' })
    expect(await f.store.head()).toEqual(before)
    expect(await f.store.get(requester, body.requestId)).toBeUndefined()
    expect(await f.store.projections(1)).toEqual([])
  }
)
it('recovers completed history under current access without rewriting its frozen evaluation policy', async () => {
  const f = await make(),
    body = request('fixture_checked_policy_history')
  const retained = await f.store.retainChecked(signed(body), requester, clock, guard())
  await f.store.evaluateChecked(
    {
      requestDigest: retained.value.digest,
      expectedRevision: '0',
      targets: [{ index: 0, disposition: 'accept', reasonCode: 'reviewed', eligible: true }]
    },
    guard()
  )
  const original = await f.store.resultChecked(requester, body.requestId, guard())
  const nextPolicy = '88'.repeat(32)
  await f.store.changePolicy(nextPolicy)
  const recovered = await f.store.resultChecked(
    requester,
    body.requestId,
    guard({ expectedPolicyDigest: nextPolicy, clock: () => '155' })
  )
  expect(recovered.head).toEqual({ policyDigest: nextPolicy, revision: '2' })
  expect(recovered.value.policyDigest).toBe(policy)
  expect(recovered.value.outcomes[0]).toMatchObject({
    actionStatus: 'applied',
    decisionId: original.value.outcomes[0].decisionId,
    revision: '1',
    serving: { state: 'suppressed', blockers: original.value.outcomes[0].serving.blockers }
  })
})
it.each(['policy', 'context'])(
  'does not commit asynchronous evidence captured before a %s change',
  async kind => {
    const f = await make(),
      body = request('fixture_checked_changed')
    const saved = await f.store.retainChecked(signed(body), requester, clock, guard())
    if (kind === 'policy') await f.store.changePolicy('88'.repeat(32))
    const before = await f.store.head()
    await expect(
      f.store.evaluateChecked(
        {
          requestDigest: saved.value.digest,
          expectedRevision: '0',
          targets: [{ index: 0, disposition: 'accept', reasonCode: 'reviewed', eligible: true }]
        },
        guard({ contextCurrent: () => kind !== 'context' })
      )
    ).rejects.toMatchObject({ code: 'context-changed' })
    expect(await f.store.head()).toEqual(before)
    expect(await f.store.projections(1)).toEqual([])
  }
)

it('samples the clock only after a separate SQLite writer releases the actual gate', async () => {
  const f = await make(),
    body = request('fixture_checked_waiting_expiry')
  const child = fork(
    fileURLToPath(new URL('./fixtures/root-commit-lock-worker.mjs', import.meta.url)),
    [],
    { cwd: f.directory, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] }
  )
  const ended = new Promise<void>(resolve => child.once('exit', () => resolve()))
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('message', () => resolve())
      child.once('error', reject)
      child.once('exit', code => reject(new Error('Clock gate worker exited early: ' + code)))
    })
    const started = performance.now()
    const sample = jest.fn(() => (performance.now() - started >= 100 ? '200' : '199'))
    child.send('release-after-wait')
    await expect(
      f.store.retainChecked(signed(body), requester, clock, guard({ clock: sample }))
    ).rejects.toMatchObject({ code: 'invalid' })
    expect(sample).toHaveBeenCalledTimes(1)
    expect(await f.store.get(requester, body.requestId)).toBeUndefined()
    expect(await f.store.head()).toEqual(head)
    await ended
    expect(child.exitCode).toBe(0)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await ended
  }
}, 15000)
