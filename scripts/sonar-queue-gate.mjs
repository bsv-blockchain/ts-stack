import { pathToFileURL } from 'node:url'

const PROJECT = 'bsv-blockchain_ts-stack'
const BASE_URL = 'https://sonarcloud.io'
const PAGE_SIZE = 500

export function queueBranch(revision) {
  if (typeof revision !== 'string' || revision.length !== 40 || !/^[a-f0-9]{40}$/.test(revision)) {
    throw new Error('Queue revision must be a full lowercase commit SHA')
  }
  return `merge-queue-${revision}`
}

function inventoryTotal(payload) {
  const total = payload?.paging?.total ?? payload?.total
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('Invalid Sonar inventory total')
  return total
}

async function inventory(request, path, parameters, field) {
  const keys = new Set()
  let expected
  for (let page = 1; ; page++) {
    const payload = await request(path, { ...parameters, ps: PAGE_SIZE, p: page })
    const total = inventoryTotal(payload)
    expected ??= total
    if (expected !== total) throw new Error('Sonar inventory changed during pagination')
    const records = payload?.[field]
    if (
      !Array.isArray(records) ||
      records.length > PAGE_SIZE ||
      (payload.paging?.pageIndex !== undefined && payload.paging.pageIndex !== page)
    ) {
      throw new Error('Malformed Sonar inventory page')
    }
    for (const record of records) {
      if (typeof record?.key !== 'string' || !record.key || keys.has(record.key)) {
        throw new Error('Missing or duplicate Sonar inventory key')
      }
      keys.add(record.key)
    }
    if (keys.size > expected) throw new Error('Sonar inventory exceeds its reported total')
    if (keys.size === expected) return expected
    if (records.length === 0) throw new Error('Sonar inventory ended before its reported total')
  }
}

/** A queue receives its own short-lived analysis; PR results cannot qualify it. */
export async function enforceSonarQueueGate(revision, dependencies = {}) {
  const branch = queueBranch(revision)
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch
  const now = dependencies.now ?? Date.now
  const sleep = dependencies.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const log = dependencies.log ?? console.log
  const deadline = now() + 10 * 60 * 1000
  const request = async (path, parameters) => {
    const url = new URL(path, BASE_URL)
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value))
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': 'bsv-ts-stack-sonar-queue-gate' },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000)
    })
    if (!response.ok) throw new Error(`Sonar API ${path} returned HTTP ${response.status}`)
    return await response.json()
  }
  const readAnalysis = async () => {
    const payload = await request('/api/project_branches/list', { project: PROJECT })
    if (!Array.isArray(payload?.branches)) throw new Error('Missing Sonar branch inventory')
    const matches = payload.branches.filter(candidate => candidate.name === branch)
    if (matches.length > 1) throw new Error('Ambiguous Sonar queue branch')
    return matches[0]
  }

  let before
  while (true) {
    before = await readAnalysis()
    if (before?.commit?.sha === revision) break
    if (now() >= deadline) throw new Error(`Timed out waiting for Sonar queue revision ${revision}`)
    log(`Waiting for Sonar queue revision ${revision}`)
    await sleep(15_000)
  }
  if (
    before.type !== 'SHORT' ||
    before.isMain !== false ||
    !Number.isFinite(Date.parse(before.analysisDate))
  ) {
    throw new Error('Queue must have a completed short-lived Sonar analysis')
  }

  const [quality, issueCount, hotspotCount] = await Promise.all([
    request('/api/qualitygates/project_status', { projectKey: PROJECT, branch }),
    inventory(
      request,
      '/api/issues/search',
      {
        componentKeys: PROJECT,
        branch,
        issueStatuses: 'OPEN,CONFIRMED,ACCEPTED,FALSE_POSITIVE'
      },
      'issues'
    ),
    inventory(
      request,
      '/api/hotspots/search',
      { projectKey: PROJECT, branch, status: 'TO_REVIEW' },
      'hotspots'
    )
  ])
  const after = await readAnalysis()
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error('Sonar queue analysis changed while collecting findings')
  }
  const qualityGateStatus = quality?.projectStatus?.status
  if (qualityGateStatus !== 'OK' || issueCount !== 0 || hotspotCount !== 0) {
    throw new Error(
      `Sonar queue gate failed at ${revision}: quality=${qualityGateStatus ?? 'missing'}, ` +
        `newFindings=${issueCount}, unreviewedHotspots=${hotspotCount}`
    )
  }
  const result = {
    revision,
    branch,
    analysisDate: before.analysisDate,
    qualityGateStatus,
    issueCount,
    hotspotCount
  }
  log(`Sonar queue zero-findings gate passed: ${JSON.stringify(result)}`)
  return result
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3)
      throw new Error('Usage: node scripts/sonar-queue-gate.mjs <queue SHA>')
    await enforceSonarQueueGate(process.argv[2])
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
