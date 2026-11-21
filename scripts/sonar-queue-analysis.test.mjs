import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertAnalysisPr,
  githubClient,
  positiveId,
  queueContext,
  revision
} from './sonar-queue-context.mjs'
import {
  cleanupAnalysisPr,
  createAnalysisPr,
  eventFromEnvironment,
  handleWorkflowRun
} from './sonar-queue-analysis.mjs'
import { CONTEXT, PR, RUN, SHA, queueFixture } from './sonar-queue-test-fixture.mjs'

test('controller accepts only canonical same-repository main queue CI identities', () => {
  assert.equal(queueContext(RUN).sha, SHA)
  for (const change of [
    { event: 'pull_request' },
    { path: '.github/workflows/other.yml' },
    { repository: { full_name: 'attacker/repo' } },
    { head_repository: { full_name: 'attacker/repo' } },
    { head_branch: 'main' },
    { head_branch: RUN.head_branch + '\n' },
    { head_branch: RUN.head_branch.replace('/main/', '/other/') },
    { head_sha: 'abc' },
    { id: 0 },
    { run_attempt: -1 }
  ])
    assert.throws(() => queueContext({ ...RUN, ...change }))
  for (const value of [SHA + '\n', SHA.toUpperCase(), '', undefined])
    assert.throws(() => revision(value))
  for (const value of [0, -1, '42', NaN, Infinity]) assert.throws(() => positiveId(value))
})

test('auxiliary PR ownership, source, target, draft and marker are required', () => {
  assert.equal(assertAnalysisPr(PR, CONTEXT).number, 71)
  for (const change of [
    { user: { id: 1, login: 'github-actions[bot]' } },
    { body: 'unowned' },
    { head: { ...PR.head, sha: 'b'.repeat(40) } },
    { head: { ...PR.head, ref: 'other' } },
    { base: { ...PR.base, ref: 'other' } },
    { draft: false },
    { state: 'closed' }
  ])
    assert.throws(() => assertAnalysisPr({ ...PR, ...change }, CONTEXT))
})

test('creation is idempotent and only writes the exact auxiliary ref and draft', async () => {
  const { state, api } = queueFixture({ prs: [] })
  await createAnalysisPr(api, CONTEXT)
  await createAnalysisPr(api, CONTEXT)
  const writes = state.calls.filter(call => call.method)
  assert.deepEqual(
    writes.map(call => [call.method, call.path]),
    [
      ['POST', '/git/refs'],
      ['POST', '/pulls']
    ]
  )
  assert.deepEqual(writes[0].body, { ref: `refs/heads/${CONTEXT.branch}`, sha: SHA })
  assert.equal(writes[1].body.draft, true)
  assert.equal(writes[1].body.base, 'main')
})

test('stale queue, diverged main and changed auxiliary ref prevent writes', async () => {
  for (const mutation of [
    state => {
      state.queueSha = 'b'.repeat(40)
    },
    state => {
      state.ancestor = false
    },
    state => {
      state.ref = { object: { sha: 'b'.repeat(40) } }
    }
  ]) {
    const { state, api } = queueFixture({ prs: [] })
    mutation(state)
    await assert.rejects(createAnalysisPr(api, CONTEXT))
    assert.equal(state.calls.filter(call => call.method).length, 0)
  }
})

test('unowned or ambiguous PRs cannot be reused', async () => {
  for (const prs of [[{ ...PR, body: 'other' }], [PR, PR]]) {
    const { api } = queueFixture({ prs })
    await assert.rejects(createAnalysisPr(api, CONTEXT))
  }
})

test('cleanup closes the owned draft and deletes only its unchanged ref', async () => {
  const { api, state } = queueFixture({ ref: { object: { sha: SHA } } })
  await cleanupAnalysisPr(api, CONTEXT)
  assert.equal(state.prs[0].state, 'closed')
  assert.equal(state.ref, null)
  assert.deepEqual(
    state.calls.filter(call => call.method).map(call => call.method),
    ['PATCH', 'DELETE']
  )
  await cleanupAnalysisPr(api, CONTEXT)
})

test('cleanup never deletes an unowned or changed ref', async () => {
  const empty = queueFixture({ prs: [], ref: { object: { sha: SHA } } })
  await cleanupAnalysisPr(empty.api, CONTEXT)
  assert.ok(empty.state.ref)
  const changed = queueFixture({ ref: { object: { sha: 'b'.repeat(40) } } })
  await assert.rejects(cleanupAnalysisPr(changed.api, CONTEXT), /changed auxiliary ref/)
  assert.ok(changed.state.ref)
})

test('workflow-run handling validates canonical attempt and lifecycle before mutations', async () => {
  const event = { repository: RUN.repository, action: 'in_progress', workflow_run: RUN }
  const fixture = queueFixture({ prs: [] })
  assert.equal((await handleWorkflowRun(event, fixture.api)).pullRequest, 71)
  fixture.state.run.run_attempt = 2
  assert.deepEqual(await handleWorkflowRun(event, fixture.api), { stale: true })
  fixture.state.run.run_attempt = 1
  assert.deepEqual(await handleWorkflowRun({ ...event, action: 'completed' }, fixture.api), {
    stale: true
  })
  fixture.state.run.status = 'completed'
  assert.equal(
    (await handleWorkflowRun({ ...event, action: 'completed' }, fixture.api)).cleaned,
    true
  )
  await assert.rejects(handleWorkflowRun({ ...event, action: 'requested' }, fixture.api))
})

test('GitHub credentials stay on the fixed API origin; redirects and failures do not pass', async () => {
  let observed
  const api = githubClient('fixture-token', async (url, options) => {
    observed = { url, options }
    return new Response('{}')
  })
  await api('/pulls')
  assert.equal(observed.url, 'https://api.github.com/repos/bsv-blockchain/ts-stack/pulls')
  assert.equal(observed.options.redirect, 'error')
  await assert.rejects(api('https://attacker.invalid'))
  await assert.rejects(
    githubClient('fixture-token', async () => new Response('', { status: 403 }))('/pulls'),
    /HTTP 403/
  )
})

test('retry attempts have separate owned refs and markers', () => {
  const retry = queueContext({ ...RUN, run_attempt: 2 })
  assert.notEqual(retry.branch, CONTEXT.branch)
  assert.notEqual(retry.marker, CONTEXT.marker)
  assert.throws(() => assertAnalysisPr(PR, retry))
})

test('cleanup refuses a promoted draft even when closed PRs are allowed', async () => {
  const fixture = queueFixture({ prs: [{ ...PR, draft: false }], ref: { object: { sha: SHA } } })
  await assert.rejects(cleanupAnalysisPr(fixture.api, CONTEXT), /open draft/)
  assert.equal(fixture.state.calls.filter(call => call.method).length, 0)
})

test('isolated qualification requires an explicit base; main remains the default', () => {
  const base = 'codex/merge-queue-sonar-canary-test'
  const run = { ...RUN, head_branch: RUN.head_branch.replace('/main/', `/${base}/`) }
  assert.throws(() => queueContext(run))
  const context = queueContext(run, base)
  assert.equal(context.baseBranch, base)
  assertAnalysisPr({ ...PR, base: { ...PR.base, ref: base } }, context)
  assert.throws(() => assertAnalysisPr(PR, context))
  for (const invalid of ['main\n', '../main', 'other', 'codex/merge-queue-sonar-canary-test\n'])
    assert.throws(() => queueContext(run, invalid))
})

test('cleanup cannot remove a branch reused by an unowned open PR', async () => {
  const fixture = queueFixture({
    prs: [
      { ...PR, state: 'closed' },
      { ...PR, number: 72, body: 'Human-owned follow-up' }
    ],
    ref: { object: { sha: SHA } }
  })
  await assert.rejects(cleanupAnalysisPr(fixture.api, CONTEXT), /unowned PR/)
  assert.equal(fixture.state.calls.filter(call => call.method).length, 0)
})

test('the controller accepts only explicit event fields and revalidates them against GitHub', async () => {
  const env = {
    GITHUB_EVENT_NAME: 'workflow_run',
    GITHUB_REPOSITORY: RUN.repository.full_name,
    QUEUE_ACTION: 'in_progress',
    QUEUE_RUN_ID: String(RUN.id),
    QUEUE_RUN_ATTEMPT: String(RUN.run_attempt),
    QUEUE_REVISION: SHA,
    QUEUE_REF: RUN.head_branch,
    GITHUB_EVENT_PATH: '/must/not/be/read'
  }
  const fixture = queueFixture({ prs: [] })
  assert.equal((await handleWorkflowRun(eventFromEnvironment(env), fixture.api)).pullRequest, 71)
  for (const change of [{ GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REPOSITORY: 'other/repo' }])
    assert.throws(() => eventFromEnvironment({ ...env, ...change }))
  for (const change of [{ QUEUE_RUN_ID: '' }, { QUEUE_REF: 'main' }, { QUEUE_REVISION: 'invalid' }])
    await assert.rejects(
      handleWorkflowRun(eventFromEnvironment({ ...env, ...change }), fixture.api)
    )
  fixture.state.run.head_repository.full_name = 'other/repo'
  await assert.rejects(handleWorkflowRun(eventFromEnvironment(env), fixture.api), /canonical/)
})
