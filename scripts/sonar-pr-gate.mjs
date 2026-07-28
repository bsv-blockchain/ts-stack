import { pathToFileURL } from 'node:url'

const DEFAULT_BASE_URL = 'https://sonarcloud.io'
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_POLL_MS = 15 * 1000

function requiredValue(argv, index, option) {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${option} requires a value`)
  }
  return value
}

function positiveInteger(value, option) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer`)
  }
  return parsed
}

export function parseArguments(argv) {
  const options = {
    baseUrl: DEFAULT_BASE_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    pollMs: DEFAULT_POLL_MS
  }

  for (let index = 0; index < argv.length; index++) {
    const option = argv[index]
    const value = requiredValue(argv, index, option)
    index++
    if (option === '--project') options.project = value
    else if (option === '--pull-request') {
      options.pullRequest = positiveInteger(value, option)
    } else if (option === '--revision') options.revision = value
    else if (option === '--base-url') options.baseUrl = value
    else if (option === '--timeout-ms') options.timeoutMs = positiveInteger(value, option)
    else if (option === '--poll-ms') options.pollMs = positiveInteger(value, option)
    else throw new Error(`Unknown option: ${option}`)
  }

  if (options.project === undefined || options.project.trim() === '') {
    throw new Error('--project is required')
  }
  if (options.pullRequest === undefined) throw new Error('--pull-request is required')
  if (!/^[0-9a-f]{40}$/i.test(options.revision ?? '')) {
    throw new Error('--revision must be a full 40-character commit SHA')
  }
  const baseUrl = new URL(options.baseUrl)
  if (baseUrl.protocol !== 'https:' && baseUrl.protocol !== 'http:') {
    throw new Error('--base-url must use HTTP or HTTPS')
  }
  options.baseUrl = baseUrl.origin
  return options
}

async function requestJson(fetchImpl, baseUrl, path, parameters) {
  const url = new URL(path, `${baseUrl}/`)
  for (const [name, value] of Object.entries(parameters)) {
    url.searchParams.set(name, String(value))
  }
  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'bsv-ts-stack-sonar-zero-findings-gate'
    },
    signal: AbortSignal.timeout(15_000)
  })
  if (!response.ok) {
    throw new Error(`SonarCloud API ${url.pathname} returned HTTP ${response.status}`)
  }
  return await response.json()
}

function resultTotal(payload, label) {
  const total = payload?.paging?.total ?? payload?.total
  if (!Number.isInteger(total) || total < 0) {
    throw new Error(`SonarCloud ${label} response did not contain a valid total`)
  }
  return total
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

export async function enforceSonarPullRequestGate(options, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch
  const sleep = dependencies.sleep ?? delay
  const now = dependencies.now ?? Date.now
  const log = dependencies.log ?? console.log
  const deadline = now() + options.timeoutMs
  let observedRevision = 'no PR analysis'

  while (true) {
    const pullRequests = await requestJson(
      fetchImpl,
      options.baseUrl,
      '/api/project_pull_requests/list',
      { project: options.project }
    )
    const analysis = pullRequests.pullRequests?.find(
      candidate => String(candidate.key) === String(options.pullRequest)
    )
    observedRevision = analysis?.commit?.sha ?? 'no PR analysis'
    if (observedRevision === options.revision) break
    if (now() >= deadline) {
      throw new Error(
        `Timed out waiting for SonarCloud PR #${options.pullRequest} analysis at ` +
          `${options.revision}; last observed ${observedRevision}`
      )
    }
    log(
      `Waiting for SonarCloud PR #${options.pullRequest} at ${options.revision}; ` +
        `last observed ${observedRevision}`
    )
    await sleep(options.pollMs)
  }

  const common = {
    pullRequest: options.pullRequest
  }
  const [qualityGate, issues, hotspots] = await Promise.all([
    requestJson(fetchImpl, options.baseUrl, '/api/qualitygates/project_status', {
      projectKey: options.project,
      ...common
    }),
    requestJson(fetchImpl, options.baseUrl, '/api/issues/search', {
      componentKeys: options.project,
      issueStatuses: 'OPEN,CONFIRMED',
      ps: 1,
      ...common
    }),
    requestJson(fetchImpl, options.baseUrl, '/api/hotspots/search', {
      projectKey: options.project,
      status: 'TO_REVIEW',
      ps: 1,
      ...common
    })
  ])

  const qualityGateStatus = qualityGate?.projectStatus?.status
  const issueCount = resultTotal(issues, 'issues')
  const hotspotCount = resultTotal(hotspots, 'hotspots')
  const failures = []
  if (qualityGateStatus !== 'OK') {
    failures.push(`quality gate status is ${qualityGateStatus ?? 'missing'}, expected OK`)
  }
  if (issueCount !== 0) {
    failures.push(`${issueCount} open or confirmed issue(s), expected 0`)
  }
  if (hotspotCount !== 0) {
    failures.push(`${hotspotCount} unreviewed security hotspot(s), expected 0`)
  }
  if (failures.length > 0) {
    throw new Error(
      `SonarCloud zero-findings gate failed for PR #${options.pullRequest} ` +
        `at ${options.revision}:\n- ${failures.join('\n- ')}`
    )
  }

  const result = {
    pullRequest: options.pullRequest,
    revision: options.revision,
    qualityGateStatus,
    issueCount,
    hotspotCount
  }
  log(
    `SonarCloud zero-findings gate passed for PR #${result.pullRequest} at ` +
      `${result.revision}: quality=${result.qualityGateStatus}, ` +
      `issues=${result.issueCount}, unreviewedHotspots=${result.hotspotCount}`
  )
  return result
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  try {
    const options = parseArguments(process.argv.slice(2))
    await enforceSonarPullRequestGate(options)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
