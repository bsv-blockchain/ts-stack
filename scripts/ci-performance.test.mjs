import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyRun,
  compareToBaseline,
  createBaseline,
  createReport,
  measureRun,
  percentile,
  summarize,
  validateBaseline
} from './ci-performance.mjs'

function actionRun(id, jobCount, durationSeconds) {
  const createdAt = '2026-07-01T00:00:00Z'
  const updatedAt = new Date(Date.parse(createdAt) + durationSeconds * 1000).toISOString()
  return {
    id,
    url: `https://github.com/bsv-blockchain/ts-stack/actions/runs/${id}`,
    headSha: String(id).padStart(40, '0'),
    createdAt,
    updatedAt,
    durationSeconds,
    queueSeconds: 3,
    prepareSeconds: 120,
    artifactTransferSeconds: 20,
    jobCount,
    jobs: []
  }
}

function report(durations, targetedDurations = durations) {
  return createReport({
    repository: 'bsv-blockchain/ts-stack',
    workflow: 'ci.yml',
    collectedAt: '2026-07-30T00:00:00.000Z',
    sampleSize: 20,
    minimumJobs: 50,
    groups: {
      fullScope: durations.map((duration, index) => actionRun(index + 1, 55, duration)),
      targeted: targetedDurations.map((duration, index) => actionRun(index + 101, 25, duration))
    }
  })
}

test('timing summaries use nearest-rank percentiles and population variance', () => {
  const values = Array.from({ length: 20 }, (_, index) => index + 1)
  assert.equal(percentile(values, 0.5), 10)
  assert.equal(percentile(values, 0.95), 19)
  assert.deepEqual(summarize(values), {
    samples: 20,
    minimum: 1,
    median: 10,
    p95: 19,
    maximum: 20,
    standardDeviation: 6
  })
})

test('run measurement retains queue, job, step, prepare, and artifact timings', () => {
  const measured = measureRun(
    {
      id: 1,
      html_url: 'https://example.test/runs/1',
      head_sha: 'a'.repeat(40),
      created_at: '2026-07-01T00:00:00Z',
      run_started_at: '2026-07-01T00:00:01Z',
      updated_at: '2026-07-01T00:02:00Z'
    },
    [
      {
        name: 'Prepare / affected scope and audited build',
        conclusion: 'success',
        started_at: '2026-07-01T00:00:03Z',
        completed_at: '2026-07-01T00:01:03Z',
        steps: [
          {
            name: 'Upload build artifact',
            conclusion: 'success',
            started_at: '2026-07-01T00:00:50Z',
            completed_at: '2026-07-01T00:01:00Z'
          }
        ]
      }
    ]
  )
  assert.equal(measured.durationSeconds, 120)
  assert.equal(measured.queueSeconds, 3)
  assert.equal(measured.prepareSeconds, 60)
  assert.equal(measured.artifactTransferSeconds, 10)
  assert.equal(measured.jobCount, 1)
  assert.equal(measured.declaredJobCount, 1)
  assert.equal(classifyRun({ jobCount: 50 }), 'fullScope')
  assert.equal(classifyRun({ jobCount: 49 }), 'targeted')
})

test('baseline comparison permits bounded noise and rejects median or p95 regressions', () => {
  const durations = Array.from({ length: 20 }, (_, index) => 500 + index)
  const baseline = createBaseline(report(durations))
  assert.deepEqual(validateBaseline(baseline), [])
  assert.deepEqual(compareToBaseline(report(durations), baseline), [])

  const regression = durations.map(duration => Math.round(duration * 1.3))
  assert.match(compareToBaseline(report(regression), baseline).join('\n'), /exceeds/)

  const incomplete = structuredClone(baseline)
  incomplete.reference.fullScope.runs.pop()
  assert.match(validateBaseline(incomplete).join('\n'), /must retain 20 run samples/)

  const duplicate = structuredClone(baseline)
  duplicate.reference.targeted.runs[0] = duplicate.reference.fullScope.runs[0]
  assert.match(
    validateBaseline(duplicate).join('\n'),
    /wrong job-count class|run ids must be unique/
  )

  const staleSummary = structuredClone(baseline)
  staleSummary.reference.fullScope.runs[0].durationSeconds += 1000
  assert.match(validateBaseline(staleSummary).join('\n'), /summary must match/)
})
