import assert from 'node:assert/strict'
import test from 'node:test'
import { enforceSonarQueueGate } from './sonar-queue-gate.mjs'
import { SHA, queueFixture } from './sonar-queue-test-fixture.mjs'

test('queue gate requires exact combined revision, genuine Sonar app and strict zero inventories', async () => {
  const { dependencies } = queueFixture()
  const result = await enforceSonarQueueGate(42, dependencies)
  assert.equal(result.revision, SHA)
  assert.equal(result.pullRequest, 71)
  assert.equal(result.issueCount, 0)
  assert.equal(result.hotspotCount, 0)
  assert.equal(result.checkRunId, 91)
})

test('missing analysis, original PR revision, wrong app or another PR cannot qualify the queue', async () => {
  for (const mutation of [
    state => {
      state.prs = []
    },
    state => {
      state.analysis.commit.sha = 'a'.repeat(40)
    },
    state => {
      state.check = null
    },
    state => {
      state.check.app.id = 15368
    },
    state => {
      state.check.head_sha = 'a'.repeat(40)
    },
    state => {
      state.check.details_url = 'https://sonarcloud.io/dashboard?id=other&pullRequest=71'
    },
    state => {
      state.check.details_url =
        'https://sonarcloud.io/dashboard?id=bsv-blockchain_ts-stack&pullRequest=72'
    },
    state => {
      state.check.status = 'in_progress'
    }
  ]) {
    const { state, dependencies } = queueFixture()
    mutation(state)
    await assert.rejects(enforceSonarQueueGate(42, dependencies), /Timed out/)
  }
})

test('failed, neutral, skipped or cancelled Sonar checks are not passes', async () => {
  for (const conclusion of ['failure', 'neutral', 'skipped', 'cancelled']) {
    const { state, dependencies } = queueFixture()
    state.check.conclusion = conclusion
    await assert.rejects(enforceSonarQueueGate(42, dependencies), /did not pass/)
  }
})

test('quality failure, every blocking issue state and unreviewed hotspots remain blocking', async () => {
  const mutations = [
    state => {
      state.quality = 'ERROR'
    },
    state => {
      state.hotspots = 1
    },
    ...['OPEN', 'CONFIRMED', 'ACCEPTED', 'FALSE_POSITIVE'].map(issueStatus => state => {
      state.issues = [{ key: 'finding', issueStatus }]
    })
  ]
  for (const mutation of mutations) {
    const { state, dependencies } = queueFixture()
    mutation(state)
    await assert.rejects(enforceSonarQueueGate(42, dependencies), /zero-findings gate failed/)
  }
})

test('changed analysis or queue identity during collection fails closed', async () => {
  const fixture = queueFixture()
  let reads = 0
  const original = fixture.dependencies.fetchImpl
  fixture.dependencies.fetchImpl = async input => {
    if (new URL(input).pathname === '/api/project_pull_requests/list' && ++reads === 3)
      fixture.state.analysis.analysisDate = '2026-11-20T20:01:00+0000'
    return await original(input)
  }
  await assert.rejects(enforceSonarQueueGate(42, fixture.dependencies), /changed during/)
  const stale = queueFixture()
  stale.state.ancestor = false
  await assert.rejects(enforceSonarQueueGate(42, stale.dependencies), /not an ancestor/)
})

test('missing analysis date, malformed inventories and API errors are not passes', async () => {
  const missing = queueFixture()
  delete missing.state.analysis.analysisDate
  await assert.rejects(enforceSonarQueueGate(42, missing.dependencies), /analysis date/)
  const failed = queueFixture()
  failed.dependencies.fetchImpl = async () => new Response('', { status: 503 })
  await assert.rejects(enforceSonarQueueGate(42, failed.dependencies), /HTTP 503/)
  const truncated = queueFixture()
  const original = truncated.dependencies.api
  truncated.dependencies.api = async path =>
    path.includes('/check-runs') ? { total_count: 101, check_runs: [] } : await original(path)
  await assert.rejects(enforceSonarQueueGate(42, truncated.dependencies), /Incomplete/)
})
