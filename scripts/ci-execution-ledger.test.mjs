import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { collectExecutionLedger, measureExecutionAttempt } from './ci-execution-ledger.mjs'

const created = '2026-09-30T00:00:00Z'
const at = seconds => new Date(Date.parse(created) + seconds * 1000).toISOString()

function run(id = 1, attempt = 1, overrides = {}) {
  return {
    id,
    run_attempt: attempt,
    head_sha: 'a'.repeat(40),
    event: 'pull_request',
    status: 'completed',
    conclusion: 'failure',
    created_at: created,
    updated_at: at(30),
    html_url: `https://example.test/runs/${id}`,
    ...overrides
  }
}

function job(id, runId = 1, attempt = 1, overrides = {}) {
  return {
    id,
    run_id: runId,
    run_attempt: attempt,
    name: 'Mutation / critical',
    status: 'completed',
    conclusion: 'failure',
    started_at: at(10),
    completed_at: at(70),
    steps: [],
    ...overrides
  }
}

test('ledger retains failed/cancelled work and does not use stale run update time as execution', () => {
  const result = measureExecutionAttempt(run(), [
    job(1),
    job(2, 1, 1, { conclusion: 'cancelled', completed_at: at(100) }),
    job(3, 1, 1, { conclusion: 'success' }),
    job(4, 1, 1, { conclusion: 'skipped' })
  ])
  assert.equal(result.knownExecutionSeconds, 210)
  assert.equal(result.cancelledExecutionSeconds, 90)
  assert.equal(result.failedExecutionSeconds, 60)
  assert.equal(result.initialAdmissionSeconds, 10)
  assert.equal(result.executionSpanSeconds, 90)
  assert.equal(result.lastObservedCompletionAt, at(100))
  assert.equal(result.mutation.skippedJobs, 1)
  assert.equal(result.mutation.knownExecutionSeconds, 210)
})

test('unfinished and invalid durations stay unknown rather than implying zero execution or success', () => {
  const result = measureExecutionAttempt(run(1, 2, { status: 'queued', conclusion: null }), [
    job(1, 1, 2, { status: 'in_progress', conclusion: null, completed_at: null }),
    job(2, 1, 2, { status: 'queued', conclusion: null, started_at: null, completed_at: null }),
    job(3, 1, 2, { started_at: 'invalid' }),
    job(4, 1, 2, { completed_at: at(5) }),
    job(5, 1, 2, { conclusion: 'skipped', started_at: null, completed_at: null })
  ])
  assert.equal(result.unmeasuredJobCount, 4)
  assert.equal(result.knownExecutionSeconds, 0)
  assert.equal(result.executionSpanSeconds, null)
  assert.equal(result.initialAdmissionSeconds, null)
  assert.equal(result.conclusion, null)
  assert.equal(result.mutation.runningJobs, 1)
  assert.equal(result.mutation.queuedJobs, 1)
})

test('measurement rejects cross-attempt and duplicated execution identities', () => {
  assert.throws(() => measureExecutionAttempt(run(), [job(1, 1, 2)]), /requested run attempt/)
  assert.throws(() => measureExecutionAttempt(run(), [job(1), job(1)]), /duplicate execution/)
})

test('skipped jobs cannot inflate execution span and invalid spans remain unknown', () => {
  const result = measureExecutionAttempt(run(), [
    job(1, 1, 1, { completed_at: at(20) }),
    job(2, 1, 1, { conclusion: 'skipped', completed_at: at(1000) })
  ])
  assert.equal(result.executionSpanSeconds, 10)
  assert.equal(result.lastObservedCompletionAt, at(20))
  assert.equal(
    measureExecutionAttempt(run(), [job(1, 1, 1, { completed_at: at(5) })]).executionSpanSeconds,
    null
  )
})

test('conflicting run retries cannot be silently deduplicated even at the window cutoff', async () => {
  await assert.rejects(
    collectExecutionLedger({
      repository: 'example/repo',
      workflow: 'ci.yml',
      maximumRuns: 1,
      request: async () => ({ workflow_runs: [run(1, 1), run(1, 2)] })
    }),
    /Conflicting duplicate execution run/
  )
})

test('collection includes every attempt and distinct runs sharing a head without success filtering', async () => {
  const requests = []
  const result = await collectExecutionLedger({
    repository: 'example/repo',
    workflow: 'ci.yml',
    request: async url => {
      requests.push(url)
      const path = new URL(url).pathname
      if (path.includes('/workflows/')) return { workflow_runs: [run(1, 2), run(1, 2), run(2)] }
      const match = /\/runs\/(\d+)\/attempts\/(\d+)/.exec(path)
      const [, id, attempt] = match.map(Number)
      if (path.endsWith('/jobs')) {
        return { total_count: 1, jobs: [job(id * 10 + attempt, id, attempt)] }
      }
      return run(id, attempt, { conclusion: id === 1 && attempt === 2 ? 'success' : 'failure' })
    }
  })
  assert.equal(result.window.runCount, 2)
  assert.equal(result.summary.attemptCount, 3)
  assert.equal(result.summary.knownExecutionSeconds, 180)
  assert.equal(result.attempts.filter(attempt => attempt.conclusion === 'failure').length, 2)
  assert.equal(new Set(result.attempts.map(attempt => attempt.headSha)).size, 1)
  assert.ok(requests.some(url => url.includes('/1/attempts/1/jobs?')))
  assert.ok(requests.every(url => !url.includes('status=success')))
  assert.equal(result.accounting.billedAmount, null)
})

test('collection paginates the exact attempt and deduplicates identical delivered job IDs', async () => {
  const all = Array.from({ length: 125 }, (_, index) => job(index + 1))
  const requests = []
  const result = await collectExecutionLedger({
    repository: 'example/repo',
    workflow: 'ci.yml',
    request: async url => {
      requests.push(url)
      const parsed = new URL(url)
      if (parsed.pathname.includes('/workflows/')) return { workflow_runs: [run()] }
      if (!parsed.pathname.endsWith('/jobs')) return run()
      const page = Number(parsed.searchParams.get('page'))
      return {
        total_count: 125,
        jobs: page === 1 ? all.slice(0, 100) : [all[99], ...all.slice(100)]
      }
    }
  })
  assert.equal(result.attempts[0].declaredJobCount, 125)
  assert.equal(result.summary.knownExecutionSeconds, 125 * 60)
  assert.ok(requests.some(url => url.includes('/attempts/1/jobs?per_page=100&page=2')))
})

test('collection rejects partial job pages, conflicting duplicates and changing attempt metadata', async () => {
  for (const failure of ['partial', 'duplicate', 'metadata']) {
    await assert.rejects(
      collectExecutionLedger({
        repository: 'example/repo',
        workflow: 'ci.yml',
        request: async url => {
          if (url.includes('/workflows/')) return { workflow_runs: [run()] }
          if (!new URL(url).pathname.endsWith('/jobs')) {
            return failure === 'metadata' ? run(1, 2) : run()
          }
          return failure === 'partial'
            ? { total_count: 2, jobs: [job(1)] }
            : { total_count: 1, jobs: [job(1), job(1, 1, 1, { conclusion: 'success' })] }
        }
      }),
      /Incomplete|Conflicting|metadata/
    )
  }
})

test('bounded window is explicit and excess attempts or incomplete history cannot be hidden', async () => {
  await assert.rejects(
    collectExecutionLedger({ repository: 'example/repo', workflow: 'ci.yml', maximumRuns: 0 }),
    /bounded ledger/
  )
  await assert.rejects(
    collectExecutionLedger({
      repository: 'example/repo',
      workflow: 'ci.yml',
      request: async () => ({ workflow_runs: [run(1, 11)] })
    }),
    /attempt count/
  )
  await assert.rejects(
    collectExecutionLedger({
      repository: 'example/repo',
      workflow: 'ci.yml',
      maximumRunPages: 1,
      request: async () => ({ workflow_runs: Array.from({ length: 100 }, () => run()) })
    }),
    /Run-page bound/
  )
})

test('window cutoff does not claim exhaustion when older runs are known to remain', async () => {
  const result = await collectExecutionLedger({
    repository: 'example/repo',
    workflow: 'ci.yml',
    maximumRuns: 1,
    request: async url => {
      if (url.includes('/workflows/')) return { workflow_runs: [run(1), run(2)] }
      if (!new URL(url).pathname.endsWith('/jobs')) return run()
      return { total_count: 1, jobs: [job(1)] }
    }
  })
  assert.equal(result.window.runCount, 1)
  assert.equal(result.window.exhaustedHistory, false)
})

test('independent attempts collect concurrently with at most four API requests and stable ordering', async () => {
  let active = 0
  let maximumActive = 0
  const result = await collectExecutionLedger({
    repository: 'example/repo',
    workflow: 'ci.yml',
    request: async url => {
      if (url.includes('/workflows/')) return { workflow_runs: [run(1, 5), run(2, 5)] }
      active++
      maximumActive = Math.max(maximumActive, active)
      try {
        await delay(1)
        const parsed = new URL(url)
        const [, id, attempt] = /\/runs\/(\d+)\/attempts\/(\d+)/.exec(parsed.pathname).map(Number)
        return parsed.pathname.endsWith('/jobs')
          ? { total_count: 1, jobs: [job(id * 10 + attempt, id, attempt)] }
          : run(id, attempt)
      } finally {
        active--
      }
    }
  })
  assert.equal(maximumActive, 4)
  assert.equal(active, 0)
  assert.equal(result.summary.attemptCount, 10)
  assert.deepEqual(
    result.attempts.map(item => [item.runId, item.attempt]),
    [
      ...Array.from({ length: 5 }, (_, index) => [1, index + 1]),
      ...Array.from({ length: 5 }, (_, index) => [2, index + 1])
    ]
  )
})
