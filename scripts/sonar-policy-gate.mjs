import { readFile, mkdir, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { enforceSonarPullRequestGate } from './sonar-pr-gate.mjs'
import {
  SONAR_BUDGET,
  readApprovedSonarBudget,
  evaluateSonarBudget
} from './sonar-pr569-budget.mjs'

function candidate(options, env, now) {
  return (
    Number.isFinite(now) &&
    now < Date.parse(SONAR_BUDGET.expiresAt) &&
    options.project === SONAR_BUDGET.project &&
    options.pullRequest === SONAR_BUDGET.pullRequest &&
    options.baseUrl === 'https://sonarcloud.io' &&
    typeof options.revision === 'string' &&
    options.revision.length === 40 &&
    /^[0-9a-f]{40}$/.test(options.revision) &&
    env.GITHUB_ACTIONS === 'true' &&
    env.GITHUB_EVENT_NAME === 'pull_request' &&
    env.GITHUB_REPOSITORY === SONAR_BUDGET.repository &&
    env.GITHUB_REF === 'refs/pull/569/merge' &&
    env.GITHUB_HEAD_REF === SONAR_BUDGET.branch &&
    env.GITHUB_BASE_REF === SONAR_BUDGET.base &&
    env.GITHUB_SERVER_URL === 'https://github.com' &&
    env.GITHUB_API_URL === 'https://api.github.com' &&
    typeof env.GITHUB_EVENT_PATH === 'string'
  )
}

function matchesPullRequest(pr, revision) {
  return (
    pr?.number === 569 &&
    pr?.state === 'open' &&
    pr?.head?.sha === revision &&
    pr?.head?.ref === SONAR_BUDGET.branch &&
    pr?.base?.ref === SONAR_BUDGET.base &&
    /^[0-9a-f]{40}$/.test(pr?.base?.sha ?? '') &&
    pr?.head?.repo?.full_name === SONAR_BUDGET.repository &&
    pr?.base?.repo?.full_name === SONAR_BUDGET.repository
  )
}

function total(payload, label) {
  const n = payload?.paging?.total ?? payload?.total
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Invalid ${label} inventory total`)
  return n
}

async function paginate(request, path, parameters, field, label) {
  const items = []
  const keys = new Set()
  let expected
  for (let page = 1; ; page++) {
    const payload = await request(`sonar-${label}-page-${page}`, path, {
      ...parameters,
      ps: 500,
      p: page
    })
    const count = total(payload, label)
    expected ??= count
    if (count !== expected) throw new Error(`${label} inventory total changed during pagination`)
    const records = payload?.[field]
    if (
      !Array.isArray(records) ||
      records.length > 500 ||
      (payload.paging?.pageIndex !== undefined && payload.paging.pageIndex !== page)
    )
      throw new Error(`Malformed ${label} inventory page`)
    for (const record of records) {
      if (typeof record?.key !== 'string' || !record.key || keys.has(record.key))
        throw new Error(`Missing or duplicate ${label} inventory key`)
      keys.add(record.key)
      items.push(record)
    }
    if (items.length > expected) throw new Error(`${label} inventory exceeded reported total`)
    if (items.length === expected) return { items, total: expected }
    if (records.length === 0) throw new Error(`${label} inventory ended before its reported total`)
  }
}

/** Actions selects this controller; there is no budget/snapshot/branch CLI switch.
 * The original strict gate remains the implementation for every other context.
 */
export async function enforceRepositorySonarGate(options, dependencies = {}) {
  const env = dependencies.env ?? process.env
  const now = dependencies.now ?? Date.now
  const log = dependencies.log ?? console.log
  if (!candidate(options, env, now())) {
    log('Sonar policy: original zero-findings gate (outside active approved PR569 context)')
    return await enforceSonarPullRequestGate(options, dependencies)
  }
  readApprovedSonarBudget()
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch
  const readEvent =
    dependencies.readEvent ?? (async path => JSON.parse(await readFile(path, 'utf8')))
  const directory = join('.sonar-policy', `pr-569-${options.revision}`)
  const persist =
    dependencies.persist ??
    (async (name, payload) => {
      // Remote values are evidence DATA only. They never select a filename,
      // become executable files or replace an earlier collection's evidence.
      if (
        typeof name !== 'string' ||
        name.length < 1 ||
        name.length > 128 ||
        /[^a-z0-9-]/.test(name)
      )
        throw new Error('Invalid controlled Sonar evidence filename')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(join(directory, `${name}.json`), `${JSON.stringify(payload, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600
      })
    })
  const summary =
    dependencies.summary ??
    (async text => {
      if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, text)
    })
  const request = async (name, path, parameters = {}) => {
    const github = path === '/repos/bsv-blockchain/ts-stack/pulls/569'
    const url = new URL(path, github ? 'https://api.github.com' : 'https://sonarcloud.io')
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value))
    const headers = { accept: 'application/json', 'user-agent': 'bsv-ts-stack-sonar-policy-gate' }
    if (github && env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`
    const response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(15_000),
      redirect: 'error'
    })
    if (!response.ok)
      throw new Error(`Policy evidence API ${url.pathname} returned HTTP ${response.status}`)
    const payload = await response.json()
    await persist(name, payload)
    return payload
  }
  const readPullRequest = name => request(name, '/repos/bsv-blockchain/ts-stack/pulls/569')
  const readAnalysis = async name => {
    const payload = await request(name, '/api/project_pull_requests/list', {
      project: options.project
    })
    const matches = payload?.pullRequests?.filter(pr => String(pr.key) === '569')
    if (!Array.isArray(matches) || matches.length > 1)
      throw new Error('Malformed Sonar PR analysis inventory')
    return matches[0]
  }
  try {
    const event = await readEvent(env.GITHUB_EVENT_PATH)
    if (
      event?.number !== 569 ||
      event?.repository?.full_name !== SONAR_BUDGET.repository ||
      !matchesPullRequest(event?.pull_request, options.revision)
    )
      throw new Error('Actions event does not match the approved PR569 context')
    const before = await readPullRequest('github-pr-before')
    if (
      !matchesPullRequest(before, options.revision) ||
      before.base.sha !== event.pull_request.base.sha
    )
      throw new Error('Live GitHub PR differs from the approved context')
    const deadline = now() + options.timeoutMs
    let analysisBefore
    let attempt = 0
    const sleep = dependencies.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    while (true) {
      analysisBefore = await readAnalysis(`sonar-analysis-wait-${++attempt}`)
      if (analysisBefore?.commit?.sha === options.revision) break
      if (now() >= deadline)
        throw new Error(`Timed out waiting for exact Sonar revision ${options.revision}`)
      log(`Waiting for Sonar PR569 analysis at ${options.revision}`)
      await sleep(options.pollMs)
    }
    const common = { pullRequest: 569 }
    // Retain every state, including accepted, false-positive and fixed records.
    const qualityGate = await request('sonar-quality-gate', '/api/qualitygates/project_status', {
      ...common,
      projectKey: options.project
    })
    const issues = await paginate(
      request,
      '/api/issues/search',
      {
        ...common,
        componentKeys: options.project,
        issueStatuses: 'OPEN,CONFIRMED,ACCEPTED,FALSE_POSITIVE,FIXED'
      },
      'issues',
      'issues'
    )
    const hotspots = await paginate(
      request,
      '/api/hotspots/search',
      {
        ...common,
        projectKey: options.project
      },
      'hotspots',
      'hotspots'
    )
    const analysisAfter = await readAnalysis('sonar-analysis-after')
    const after = await readPullRequest('github-pr-after')
    if (!matchesPullRequest(after, options.revision) || before.base.sha !== after.base.sha)
      throw new Error('GitHub head/base context changed while collecting Sonar evidence')
    const snapshot = {
      repository: SONAR_BUDGET.repository,
      project: options.project,
      pullRequest: 569,
      branch: before.head.ref,
      base: before.base.ref,
      revision: options.revision,
      analysisBefore,
      analysisAfter,
      qualityGate,
      issues: issues.items,
      issueTotal: issues.total,
      hotspots: hotspots.items,
      hotspotTotal: hotspots.total,
      collectedAt: new Date(now()).toISOString()
    }
    await persist('snapshot', snapshot)
    const result = evaluateSonarBudget(snapshot, now())
    await persist('verdict', result)
    log(JSON.stringify(result, null, 2))
    await summary(
      `### Sonar policy at ${options.revision}\n\n` +
        `- Original zero-findings verdict: ${result.originalZeroFindingsSatisfied ? 'PASS' : 'FAIL'}\n` +
        `- Approved PR569 budget verdict: ${result.scopedBudgetSatisfied ? 'PASS' : 'FAIL'}\n` +
        `- Active findings: ${result.activeFindings}; maintainability-only: ${result.maintainabilityFindings}\n` +
        `- Full raw inventories and both verdicts: Sonar policy evidence artifact\n` +
        `- Expiry: ${SONAR_BUDGET.expiresAt}; this result does not establish full-system qualification.\n`
    )
    if (!result.scopedBudgetSatisfied)
      throw new Error(`Approved PR569 Sonar budget failed:\n- ${result.failures.join('\n- ')}`)
    return result
  } catch (error) {
    await persist('failure', {
      revision: options.revision,
      error: error instanceof Error ? error.message : String(error)
    })
    throw error
  }
}
