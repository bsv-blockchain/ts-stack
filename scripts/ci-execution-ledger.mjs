// Execution accounting is separate from successful-head latency qualification.
const PAGE_SIZE = 100
const MAX_JOB_PAGES = 10

function instant(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : null
}

function seconds(start, end) {
  const a = instant(start)
  const b = instant(end)
  return a !== null && b !== null && b >= a ? (b - a) / 1000 : null
}

function positiveInteger(value, maximum, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Invalid bounded ledger ${name}`)
  }
}

export function measureExecutionAttempt(run, jobs) {
  const seen = new Set()
  const measured = jobs.map(job => {
    if (!Number.isSafeInteger(job.id) || job.id < 1 || seen.has(job.id)) {
      throw new Error('Missing or duplicate execution job ID')
    }
    seen.add(job.id)
    if (job.run_id !== run.id || job.run_attempt !== run.run_attempt) {
      throw new Error('Execution job does not match the requested run attempt')
    }
    const executionSeconds =
      job.conclusion === 'skipped' ? 0 : seconds(job.started_at, job.completed_at)
    return {
      id: job.id,
      name: job.name,
      status: job.status,
      conclusion: job.conclusion ?? null,
      startedAt: job.started_at ?? null,
      completedAt: job.completed_at ?? null,
      executionSeconds,
      steps: (job.steps ?? []).map(step => ({
        number: step.number,
        name: step.name,
        conclusion: step.conclusion ?? null,
        executionSeconds: seconds(step.started_at, step.completed_at)
      }))
    }
  })
  const sum = subset => subset.reduce((total, job) => total + (job.executionSeconds ?? 0), 0)
  const mutation = measured.filter(job => job.name.startsWith('Mutation / '))
  const starts = measured
    .filter(job => job.conclusion !== 'skipped')
    .map(job => instant(job.startedAt))
  const validStarts = starts.filter(value => value !== null)
  const completions = measured
    .filter(job => job.conclusion !== 'skipped')
    .map(job => instant(job.completedAt))
    .filter(value => value !== null)
  const firstStart = validStarts.length ? Math.min(...validStarts) : null
  const lastCompletion = completions.length ? Math.max(...completions) : null
  return {
    runId: run.id,
    attempt: run.run_attempt,
    headSha: run.head_sha,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion ?? null,
    url: `${run.html_url}/attempts/${run.run_attempt}`,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    // Creation-to-start includes retry waiting on later attempts: do not call it queue.
    initialAdmissionSeconds:
      run.run_attempt === 1 && firstStart !== null
        ? seconds(run.created_at, new Date(firstStart).toISOString())
        : null,
    executionSpanSeconds:
      run.status === 'completed' &&
      firstStart !== null &&
      lastCompletion !== null &&
      lastCompletion >= firstStart
        ? (lastCompletion - firstStart) / 1000
        : null,
    lastObservedCompletionAt:
      lastCompletion === null ? null : new Date(lastCompletion).toISOString(),
    declaredJobCount: measured.length,
    unmeasuredJobCount: measured.filter(job => job.executionSeconds === null).length,
    knownExecutionSeconds: sum(measured),
    cancelledExecutionSeconds: sum(measured.filter(job => job.conclusion === 'cancelled')),
    failedExecutionSeconds: sum(measured.filter(job => job.conclusion === 'failure')),
    mutation: {
      declaredJobs: mutation.length,
      completedJobs: mutation.filter(job => job.status === 'completed').length,
      skippedJobs: mutation.filter(job => job.conclusion === 'skipped').length,
      runningJobs: mutation.filter(job => job.status === 'in_progress').length,
      queuedJobs: mutation.filter(job => job.status === 'queued').length,
      knownExecutionSeconds: sum(mutation)
    },
    jobs: measured
  }
}

async function attemptJobs(apiRoot, runId, attempt, request) {
  const jobs = new Map()
  for (let page = 1; page <= MAX_JOB_PAGES; page++) {
    const data = await request(
      `${apiRoot}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=${PAGE_SIZE}&page=${page}`
    )
    if (!Array.isArray(data.jobs) || !Number.isSafeInteger(data.total_count)) {
      throw new TypeError('Malformed attempt jobs response')
    }
    for (const job of data.jobs) {
      const previous = jobs.get(job.id)
      if (previous && JSON.stringify(previous) !== JSON.stringify(job)) {
        throw new Error('Conflicting duplicate execution job evidence')
      }
      jobs.set(job.id, job)
    }
    if (jobs.size === data.total_count) return [...jobs.values()]
    if (jobs.size > data.total_count || data.jobs.length < PAGE_SIZE) {
      throw new Error('Incomplete or inconsistent attempt jobs response')
    }
  }
  throw new Error('Attempt exceeds the job-page bound; refusing partial evidence')
}

function rememberRun(candidates, run, maximumRuns) {
  positiveInteger(run.id, Number.MAX_SAFE_INTEGER, 'run ID')
  const previous = candidates.get(run.id)
  if (previous && JSON.stringify(previous) !== JSON.stringify(run)) {
    throw new Error('Conflicting duplicate execution run evidence')
  }
  if (!previous && candidates.size < maximumRuns) candidates.set(run.id, run)
}

async function collectRunWindow(apiRoot, workflow, maximumRuns, maximumRunPages, request) {
  const candidates = new Map()
  let pagesRead = 0
  let exhaustedHistory = false
  for (let page = 1; page <= maximumRunPages && candidates.size < maximumRuns; page++) {
    const data = await request(
      `${apiRoot}/actions/workflows/${encodeURIComponent(workflow)}/runs?event=pull_request&per_page=${PAGE_SIZE}&page=${page}`
    )
    if (!Array.isArray(data.workflow_runs)) throw new TypeError('Malformed execution runs response')
    pagesRead++
    for (const run of data.workflow_runs) {
      rememberRun(candidates, run, maximumRuns)
    }
    if (data.workflow_runs.length < PAGE_SIZE) {
      exhaustedHistory = data.workflow_runs.every(run => candidates.has(run.id))
      break
    }
  }
  if (candidates.size < maximumRuns && !exhaustedHistory) {
    throw new Error('Run-page bound reached before the requested ledger window')
  }
  return { candidates, pagesRead, exhaustedHistory }
}

async function collectAttempt(apiRoot, run, attempt, request) {
  const metadata = await request(`${apiRoot}/actions/runs/${run.id}/attempts/${attempt}`)
  if (
    metadata.id !== run.id ||
    metadata.run_attempt !== attempt ||
    metadata.head_sha !== run.head_sha
  ) {
    throw new Error('Attempt metadata does not match its run/head')
  }
  return measureExecutionAttempt(metadata, await attemptJobs(apiRoot, run.id, attempt, request))
}

async function collectAttemptBatch(apiRoot, descriptors, request, offset = 0) {
  if (offset >= descriptors.length) return []
  const batch = descriptors.slice(offset, offset + 4)
  const measured = await Promise.all(
    batch.map(({ run, attempt }) => collectAttempt(apiRoot, run, attempt, request))
  )
  return [...measured, ...(await collectAttemptBatch(apiRoot, descriptors, request, offset + 4))]
}

function collectAttempts(apiRoot, candidates, maximumAttempts, request) {
  const descriptors = [...candidates.values()].flatMap(run => {
    positiveInteger(run.run_attempt, maximumAttempts, 'attempt count')
    return Array.from({ length: run.run_attempt }, (_, index) => ({ run, attempt: index + 1 }))
  })
  // Independent attempts share at most four API requests; pages within an
  // attempt remain sequential so completeness is checked before proceeding.
  return collectAttemptBatch(apiRoot, descriptors, request)
}

export async function collectExecutionLedger({
  repository,
  workflow,
  request,
  maximumRuns = 20,
  maximumAttempts = 10,
  maximumRunPages = 10,
  collectedAt = new Date().toISOString()
}) {
  positiveInteger(maximumRuns, 100, 'run window')
  positiveInteger(maximumAttempts, 100, 'attempt count')
  positiveInteger(maximumRunPages, 10, 'run pages')
  const apiRoot = `https://api.github.com/repos/${repository}`
  const { candidates, pagesRead, exhaustedHistory } = await collectRunWindow(
    apiRoot,
    workflow,
    maximumRuns,
    maximumRunPages,
    request
  )
  const attempts = await collectAttempts(apiRoot, candidates, maximumAttempts, request)
  return {
    schemaVersion: 1,
    collectedAt,
    source: { repository, workflow, event: 'pull_request', outcomes: 'all' },
    window: { maximumRuns, runCount: candidates.size, pagesRead, exhaustedHistory },
    accounting: {
      unit: 'runner execution seconds, including setup/teardown',
      incompleteDurations: 'unknown; excluded from known execution lower bound',
      jobQueue: 'unavailable; dependency/matrix waiting is not runner queue',
      selectedScope: 'unavailable; declared jobs are not a source/target union proof',
      cancellationReason: 'unavailable; cancelled does not distinguish timeout/supersession',
      billedAmount: null,
      qualification: 'not inferred from execution or skipped jobs'
    },
    summary: {
      attemptCount: attempts.length,
      knownExecutionSeconds: attempts.reduce(
        (sum, attempt) => sum + attempt.knownExecutionSeconds,
        0
      ),
      mutationExecutionSeconds: attempts.reduce(
        (sum, attempt) => sum + attempt.mutation.knownExecutionSeconds,
        0
      ),
      cancelledExecutionSeconds: attempts.reduce(
        (sum, attempt) => sum + attempt.cancelledExecutionSeconds,
        0
      ),
      unmeasuredJobCount: attempts.reduce((sum, attempt) => sum + attempt.unmeasuredJobCount, 0)
    },
    attempts
  }
}
