#!/usr/bin/env node

import { appendFile, readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const DEFAULT_REPOSITORY = 'bsv-blockchain/ts-stack'
const DEFAULT_SAMPLE_SIZE = 20
const FULL_SCOPE_MINIMUM_JOBS = 50
const MAX_RUNS = 100

function secondsBetween(start, end) {
  if (!start || !end) return null
  const milliseconds = new Date(end).valueOf() - new Date(start).valueOf()
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? Math.round(milliseconds / 1000) : null
}

function finite(values) {
  return values.filter(value => Number.isFinite(value))
}

export function percentile(values, fraction) {
  const sorted = finite(values).sort((left, right) => left - right)
  if (sorted.length === 0) return null
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]
}

export function summarize(values) {
  const samples = finite(values)
  if (samples.length === 0) {
    return {
      samples: 0,
      minimum: null,
      median: null,
      p95: null,
      maximum: null,
      standardDeviation: null
    }
  }
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length
  const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length
  return {
    samples: samples.length,
    minimum: Math.min(...samples),
    median: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    maximum: Math.max(...samples),
    standardDeviation: Math.round(Math.sqrt(variance))
  }
}

function stepMetrics(step) {
  return {
    name: step.name,
    conclusion: step.conclusion,
    durationSeconds: secondsBetween(step.started_at, step.completed_at)
  }
}

export function measureRun(run, jobs) {
  const startedJobs = jobs.filter(job => job.started_at)
  const earliestJob = [...startedJobs].sort((left, right) =>
    left.started_at.localeCompare(right.started_at)
  )[0]
  const measuredJobs = jobs.map(job => ({
    name: job.name,
    conclusion: job.conclusion,
    queueSeconds: secondsBetween(run.created_at, job.started_at),
    durationSeconds: secondsBetween(job.started_at, job.completed_at),
    steps: (job.steps ?? []).map(stepMetrics)
  }))
  const artifactTransferSeconds = measuredJobs
    .flatMap(job => job.steps)
    .filter(step =>
      /\b(?:upload|download)\b.*\bartifact\b|\bartifact\b.*\b(?:upload|download)\b/i.test(step.name)
    )
    .reduce((sum, step) => sum + (step.durationSeconds ?? 0), 0)
  const prepareJob = measuredJobs.find(job =>
    /^(?:Build, lint, and policy|Prepare(?:\s*\/|$))/i.test(job.name)
  )
  const executedJobs = jobs.filter(job => job.conclusion !== 'skipped')
  return {
    id: run.id,
    url: run.html_url,
    headSha: run.head_sha,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    durationSeconds: secondsBetween(run.created_at, run.updated_at),
    queueSeconds: secondsBetween(run.created_at, earliestJob?.started_at),
    prepareSeconds: prepareJob?.durationSeconds ?? null,
    artifactTransferSeconds,
    jobCount: executedJobs.length,
    declaredJobCount: jobs.length,
    jobs: measuredJobs
  }
}

export function classifyRun(run, minimumJobs = FULL_SCOPE_MINIMUM_JOBS) {
  return run.jobCount >= minimumJobs ? 'fullScope' : 'targeted'
}

function groupSummary(runs) {
  return {
    runCount: runs.length,
    durationSeconds: summarize(runs.map(run => run.durationSeconds)),
    queueSeconds: summarize(runs.map(run => run.queueSeconds)),
    prepareSeconds: summarize(runs.map(run => run.prepareSeconds)),
    artifactTransferSeconds: summarize(runs.map(run => run.artifactTransferSeconds)),
    jobCount: summarize(runs.map(run => run.jobCount))
  }
}

export function createReport({
  repository,
  workflow,
  collectedAt,
  sampleSize,
  minimumJobs,
  groups
}) {
  return {
    schemaVersion: 1,
    collectedAt,
    source: {
      repository,
      workflow,
      event: 'pull_request',
      conclusion: 'success'
    },
    classification: {
      fullScopeMinimumJobs: minimumJobs,
      sampleSizePerClass: sampleSize
    },
    observability: {
      captured: [
        'run duration and variance',
        'per-job and per-step duration',
        'job queue time',
        'artifact upload/download step duration'
      ],
      unavailableFromActionsApi: [
        'hosted-runner CPU utilization',
        'hosted-runner memory utilization',
        'action-internal cache hit rate'
      ],
      note: 'Unavailable metrics require explicit in-run instrumentation; they are not inferred from the GitHub Actions REST API.'
    },
    groups: Object.fromEntries(
      Object.entries(groups).map(([name, runs]) => [name, { summary: groupSummary(runs), runs }])
    )
  }
}

function compactRun(run) {
  return {
    id: run.id,
    url: run.url,
    headSha: run.headSha,
    createdAt: run.createdAt,
    durationSeconds: run.durationSeconds,
    queueSeconds: run.queueSeconds,
    prepareSeconds: run.prepareSeconds,
    artifactTransferSeconds: run.artifactTransferSeconds,
    jobCount: run.jobCount,
    declaredJobCount: run.declaredJobCount
  }
}

export function createBaseline(report) {
  return {
    schemaVersion: 1,
    recordedAt: report.collectedAt,
    source: report.source,
    classification: report.classification,
    regressionBudget: {
      fullScope: { medianPercent: 15, p95Percent: 20 },
      targeted: { medianPercent: 20, p95Percent: 25 }
    },
    observability: report.observability,
    reference: Object.fromEntries(
      Object.entries(report.groups).map(([name, group]) => [
        name,
        {
          summary: group.summary,
          runs: group.runs.map(compactRun)
        }
      ])
    )
  }
}

export function validateBaseline(baseline) {
  const errors = []
  if (baseline?.schemaVersion !== 1) errors.push('baseline schemaVersion must be 1')
  if (
    baseline?.source?.repository !== DEFAULT_REPOSITORY ||
    baseline?.source?.workflow !== 'ci.yml' ||
    baseline?.source?.event !== 'pull_request' ||
    baseline?.source?.conclusion !== 'success'
  ) {
    errors.push('baseline source must be successful ts-stack pull-request ci.yml runs')
  }
  if (baseline?.classification?.sampleSizePerClass !== DEFAULT_SAMPLE_SIZE) {
    errors.push(`baseline sampleSizePerClass must be ${DEFAULT_SAMPLE_SIZE}`)
  }
  if (baseline?.classification?.fullScopeMinimumJobs !== FULL_SCOPE_MINIMUM_JOBS) {
    errors.push(`baseline fullScopeMinimumJobs must be ${FULL_SCOPE_MINIMUM_JOBS}`)
  }
  for (const name of ['fullScope', 'targeted']) {
    const reference = baseline?.reference?.[name]
    if (reference?.runs?.length !== DEFAULT_SAMPLE_SIZE) {
      errors.push(`baseline ${name} must retain ${DEFAULT_SAMPLE_SIZE} run samples`)
    }
    if (reference?.summary?.runCount !== DEFAULT_SAMPLE_SIZE) {
      errors.push(`baseline ${name} summary runCount must be ${DEFAULT_SAMPLE_SIZE}`)
    }
    const runs = Array.isArray(reference?.runs) ? reference.runs : []
    const expectedFullScope = name === 'fullScope'
    for (const run of runs) {
      if (
        !Number.isSafeInteger(run?.id) ||
        run.id <= 0 ||
        run.url !== `https://github.com/${DEFAULT_REPOSITORY}/actions/runs/${run.id}` ||
        !/^[0-9a-f]{40}$/.test(run?.headSha ?? '') ||
        !Number.isFinite(Date.parse(run?.createdAt))
      ) {
        errors.push(`baseline ${name} contains an invalid exact run reference`)
        break
      }
      if (run.jobCount >= FULL_SCOPE_MINIMUM_JOBS !== expectedFullScope) {
        errors.push(`baseline ${name} contains a run in the wrong job-count class`)
        break
      }
    }
    if (
      runs.length === DEFAULT_SAMPLE_SIZE &&
      JSON.stringify(reference.summary) !== JSON.stringify(groupSummary(runs))
    ) {
      errors.push(`baseline ${name} summary must match its retained run samples`)
    }
    for (const metric of ['median', 'p95']) {
      if (!Number.isFinite(reference?.summary?.durationSeconds?.[metric])) {
        errors.push(`baseline ${name} duration ${metric} must be finite`)
      }
    }
    for (const metric of ['medianPercent', 'p95Percent']) {
      const value = baseline?.regressionBudget?.[name]?.[metric]
      if (!Number.isFinite(value) || value <= 0 || value > 100) {
        errors.push(`baseline ${name} ${metric} must be between 1 and 100`)
      }
    }
  }
  const allRuns = Object.values(baseline?.reference ?? {}).flatMap(reference =>
    Array.isArray(reference?.runs) ? reference.runs : []
  )
  if (new Set(allRuns.map(run => run.id)).size !== allRuns.length) {
    errors.push('baseline run ids must be unique')
  }
  if (new Set(allRuns.map(run => run.headSha)).size !== allRuns.length) {
    errors.push('baseline run head SHAs must be unique')
  }
  return errors
}

export function compareToBaseline(report, baseline) {
  const errors = validateBaseline(baseline)
  if (errors.length > 0) return errors
  for (const name of ['fullScope', 'targeted']) {
    const actual = report.groups[name]?.summary
    if (actual?.runCount !== baseline.classification.sampleSizePerClass) {
      errors.push(
        `${name} report has ${actual?.runCount ?? 0} runs; ` +
          `expected ${baseline.classification.sampleSizePerClass}`
      )
      continue
    }
    const reference = baseline.reference[name].summary.durationSeconds
    const budget = baseline.regressionBudget[name]
    for (const [metric, percentField] of [
      ['median', 'medianPercent'],
      ['p95', 'p95Percent']
    ]) {
      const maximum = Math.ceil(reference[metric] * (1 + budget[percentField] / 100))
      if (actual.durationSeconds[metric] > maximum) {
        errors.push(
          `${name} duration ${metric} ${actual.durationSeconds[metric]}s exceeds ` +
            `${maximum}s (${budget[percentField]}% over ${reference[metric]}s baseline)`
        )
      }
    }
  }
  return errors
}

async function githubJson(url, token) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'ts-stack-ci-performance',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  })
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} for ${url}: ${await response.text()}`)
  }
  return await response.json()
}

async function collectReport({
  repository,
  workflow,
  token,
  sampleSize = DEFAULT_SAMPLE_SIZE,
  minimumJobs = FULL_SCOPE_MINIMUM_JOBS
}) {
  const apiRoot = `https://api.github.com/repos/${repository}`
  const encodedWorkflow = encodeURIComponent(workflow)
  const runData = await githubJson(
    `${apiRoot}/actions/workflows/${encodedWorkflow}/runs?event=pull_request&status=success&per_page=${MAX_RUNS}`,
    token
  )
  const candidates = (runData.workflow_runs ?? []).filter(
    run => run.status === 'completed' && run.conclusion === 'success'
  )
  const groups = { fullScope: [], targeted: [] }
  const batchSize = 8
  for (let index = 0; index < candidates.length; index += batchSize) {
    const batch = candidates.slice(index, index + batchSize)
    const measured = await Promise.all(
      batch.map(async run => {
        const data = await githubJson(`${run.jobs_url}?per_page=100`, token)
        return measureRun(run, data.jobs ?? [])
      })
    )
    for (const run of measured) {
      const classification = classifyRun(run, minimumJobs)
      if (groups[classification].length < sampleSize) groups[classification].push(run)
    }
    if (Object.values(groups).every(runs => runs.length === sampleSize)) break
  }
  for (const [name, runs] of Object.entries(groups)) {
    if (runs.length !== sampleSize) {
      throw new Error(
        `Only ${runs.length} ${name} successful PR runs were available; expected ${sampleSize}`
      )
    }
  }
  return createReport({
    repository,
    workflow,
    collectedAt: new Date().toISOString(),
    sampleSize,
    minimumJobs,
    groups
  })
}

function renderSummary(report, comparisons) {
  const lines = [
    '## CI performance trend',
    '',
    '| Scope | Runs | Duration median | Duration p95 | Queue median | Prepare median | Artifact transfer median |',
    '|---|---:|---:|---:|---:|---:|---:|'
  ]
  for (const [name, group] of Object.entries(report.groups)) {
    const summary = group.summary
    const seconds = value => (value === null ? 'unavailable' : `${value}s`)
    lines.push(
      `| ${name} | ${summary.runCount} | ${seconds(summary.durationSeconds.median)} | ` +
        `${seconds(summary.durationSeconds.p95)} | ${seconds(summary.queueSeconds.median)} | ` +
        `${seconds(summary.prepareSeconds.median)} | ` +
        `${seconds(summary.artifactTransferSeconds.median)} |`
    )
  }
  lines.push(
    '',
    comparisons.length === 0
      ? 'Performance budget: passed.'
      : `Performance budget: failed.\n\n${comparisons.map(error => `- ${error}`).join('\n')}`,
    '',
    'GitHub-hosted CPU, memory, and action-internal cache-hit data are not exposed by the Actions REST API and remain an explicit instrumentation gap.'
  )
  return `${lines.join('\n')}\n`
}

function option(arguments_, name) {
  const index = arguments_.indexOf(name)
  return index === -1 ? undefined : arguments_[index + 1]
}

async function main(arguments_) {
  const baselinePath = option(arguments_, '--baseline')
  const outputPath = option(arguments_, '--output')
  const writeBaselinePath = option(arguments_, '--write-baseline')
  const workflow = option(arguments_, '--workflow') ?? 'ci.yml'
  if (!arguments_.includes('--collect')) {
    throw new Error(
      'Usage: ci-performance.mjs --collect [--baseline file] [--output file] ' +
        '[--write-baseline file] [--workflow ci.yml]'
    )
  }
  const token = process.env.GITHUB_TOKEN
  if (!token) throw new Error('GITHUB_TOKEN is required for --collect')
  const report = await collectReport({
    repository: process.env.GITHUB_REPOSITORY ?? DEFAULT_REPOSITORY,
    workflow,
    token
  })
  if (outputPath) await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`)
  if (writeBaselinePath) {
    await writeFile(writeBaselinePath, `${JSON.stringify(createBaseline(report), null, 2)}\n`)
  }
  let comparisons = []
  if (baselinePath) {
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8'))
    comparisons = compareToBaseline(report, baseline)
  }
  const summary = renderSummary(report, comparisons)
  process.stdout.write(summary)
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, summary)
  }
  if (comparisons.length > 0) throw new Error(comparisons.join('\n'))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
