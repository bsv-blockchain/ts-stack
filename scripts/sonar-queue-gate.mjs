import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { enforceSonarPullRequestGate, parseArguments } from './sonar-pr-gate.mjs'
import {
  assertActiveQueue,
  assertAnalysisPr,
  findAnalysisPr,
  githubClient,
  positiveId,
  queueContext
} from './sonar-queue-context.mjs'

const PROJECT = 'bsv-blockchain_ts-stack'

async function readAnalysis(fetchImpl, number) {
  const response = await fetchImpl(
    `https://sonarcloud.io/api/project_pull_requests/list?project=${PROJECT}`,
    {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15000)
    }
  )
  if (!response.ok) throw new Error(`Sonar PR inventory: HTTP ${response.status}`)
  const payload = await response.json()
  if (!Array.isArray(payload.pullRequests)) throw new Error('Missing Sonar PR inventory')
  const matches = payload.pullRequests.filter(pr => pr.key === String(number))
  if (matches.length > 1) throw new Error('Ambiguous Sonar analysis identity')
  return matches[0]
}

function isAnalysisCheck(check, context, number) {
  if (
    check.app?.id !== 12526 ||
    check.name !== 'SonarCloud Code Analysis' ||
    check.head_sha !== context.sha
  )
    return false
  const url = new URL(check.details_url)
  return (
    url.origin === 'https://sonarcloud.io' &&
    url.searchParams.get('id') === PROJECT &&
    url.searchParams.get('pullRequest') === String(number)
  )
}

async function completedAnalysis(api, fetchImpl, context) {
  const pr = await findAnalysisPr(api, context)
  if (!pr) return null
  const analysis = await readAnalysis(fetchImpl, pr.number)
  if (analysis?.commit?.sha !== context.sha) return null
  if (!Number.isFinite(Date.parse(analysis.analysisDate)))
    throw new Error('Missing Sonar analysis date')
  const checks = await api(
    `/commits/${context.sha}/check-runs?check_name=SonarCloud%20Code%20Analysis&filter=latest&per_page=100`
  )
  if (
    !Array.isArray(checks.check_runs) ||
    !Number.isSafeInteger(checks.total_count) ||
    checks.total_count > 100 ||
    checks.total_count !== checks.check_runs.length
  )
    throw new Error('Incomplete Sonar check inventory')
  const check = checks.check_runs.find(candidate => isAnalysisCheck(candidate, context, pr.number))
  if (check?.status !== 'completed') return null
  if (check.conclusion !== 'success')
    throw new Error(`Sonar app check did not pass: ${check.conclusion}`)
  return { pr, analysis, check }
}

async function waitForAnalysis(read, deadline, { now, sleep, log }) {
  const result = await read()
  if (result) return result
  if (now() >= deadline) throw new Error('Timed out waiting for genuine auxiliary Sonar analysis')
  log('Waiting for the exact queue commit analysis and Sonar app check')
  await sleep(15000)
  return await waitForAnalysis(read, deadline, { now, sleep, log })
}

export async function enforceSonarQueueGate(runId, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch
  const api = dependencies.api ?? githubClient(process.env.GITHUB_TOKEN, fetchImpl)
  const now = dependencies.now ?? Date.now
  const sleep = dependencies.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const log = dependencies.log ?? console.log
  const context = queueContext(
    await api(`/actions/runs/${positiveId(runId)}`),
    dependencies.baseBranch ?? 'main'
  )
  await assertActiveQueue(api, context)
  const before = await waitForAnalysis(
    () => completedAnalysis(api, fetchImpl, context),
    now() + 10 * 60 * 1000,
    { now, sleep, log }
  )
  const options = parseArguments([
    '--project',
    PROJECT,
    '--pull-request',
    String(before.pr.number),
    '--revision',
    context.sha
  ])
  // Auxiliary PRs always use the original zero-findings policy, never a PR-specific exception.
  const result = await enforceSonarPullRequestGate(options, { fetchImpl, now, sleep, log })
  const after = await readAnalysis(fetchImpl, before.pr.number)
  if (JSON.stringify(before.analysis) !== JSON.stringify(after))
    throw new Error('Sonar analysis changed during inventory collection')
  assertAnalysisPr(await api(`/pulls/${before.pr.number}`), context)
  await assertActiveQueue(api, context)
  return {
    ...result,
    runId,
    analysisDate: after.analysisDate,
    checkRunId: before.check.id,
    pullRequestUrl: before.pr.html_url
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.env.GITHUB_EVENT_NAME !== 'merge_group') throw new Error('Expected merge_group')
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
    const result = await enforceSonarQueueGate(Number(process.env.GITHUB_RUN_ID))
    if (result.revision !== event.merge_group?.head_sha)
      throw new Error('Event and canonical run revisions differ')
    mkdirSync('.sonar-policy', { recursive: true })
    writeFileSync(
      `.sonar-policy/queue-${result.revision}.json`,
      JSON.stringify(result, null, 2) + '\n'
    )
    console.log(`Sonar queue zero-findings gate passed: ${JSON.stringify(result)}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
