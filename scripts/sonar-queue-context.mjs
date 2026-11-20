export const REPOSITORY = 'bsv-blockchain/ts-stack'
export const BOT_LOGIN = 'github-actions[bot]'
export const BOT_ID = 41898282
export const ANALYSIS_PREFIX = 'codex/merge-queue-analysis/'

export function revision(value) {
  if (typeof value !== 'string' || value.length !== 40 || !/^[a-f0-9]{40}$/.test(value))
    throw new Error('Expected a full lowercase commit SHA')
  return value
}

export function positiveId(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Expected a positive GitHub ID')
  return value
}

// The CLI always uses main. An explicit base is available to isolated qualification fixtures.
export function queueContext(run, baseBranch = 'main') {
  if (
    !/^(?:main|codex\/merge-queue-sonar-canary-[a-z0-9-]+)$/.test(baseBranch) ||
    baseBranch !== baseBranch.trim()
  )
    throw new Error('Unexpected queue base branch')
  const sha = revision(run.head_sha)
  if (
    run.event !== 'merge_group' ||
    run.path !== '.github/workflows/ci.yml' ||
    run.repository?.full_name !== REPOSITORY ||
    run.head_repository?.full_name !== REPOSITORY ||
    typeof run.head_branch !== 'string' ||
    run.head_branch !== run.head_branch.trim() ||
    !run.head_branch.startsWith(`gh-readonly-queue/${baseBranch}/`) ||
    !/^pr-[1-9][0-9]*-[a-f0-9]{40}$/.test(
      run.head_branch.slice(`gh-readonly-queue/${baseBranch}/`.length)
    )
  )
    throw new Error('Not a canonical CI merge-group run for the configured base')
  return {
    sha,
    baseBranch,
    runId: positiveId(run.id),
    attempt: positiveId(run.run_attempt),
    queueRef: run.head_branch,
    branch: `${ANALYSIS_PREFIX}${run.id}-${run.run_attempt}-${sha}`,
    marker: `<!-- ts-stack-queue-analysis:v1 run=${run.id} attempt=${run.run_attempt} head=${sha} -->`
  }
}

export function githubClient(token, fetchImpl = globalThis.fetch) {
  if (!token) throw new Error('GITHUB_TOKEN is required')
  return async (path, { method = 'GET', body, allowMissing = false } = {}) => {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid GitHub API path')
    const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28'
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000)
    })
    if (allowMissing && response.status === 404) return null
    if (!response.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}`)
    return response.status === 204 ? null : await response.json()
  }
}

export async function assertActiveQueue(api, context) {
  const ref = await api(`/git/ref/heads/${context.queueRef}`)
  if (ref?.object?.sha !== context.sha)
    throw new Error('Queue ref no longer identifies this commit')
  const base = await api(`/git/ref/heads/${context.baseBranch}`)
  const comparison = await api(`/compare/${revision(base.object.sha)}...${context.sha}`)
  if (
    !['ahead', 'identical'].includes(comparison.status) ||
    comparison.merge_base_commit?.sha !== base.object.sha
  )
    throw new Error('Current base is not an ancestor of this queue commit')
}

export function assertAnalysisPr(pr, context, { allowClosed = false } = {}) {
  if (
    pr?.user?.id !== BOT_ID ||
    pr.user.login !== BOT_LOGIN ||
    pr.head?.sha !== context.sha ||
    pr.head.ref !== context.branch ||
    pr.head.repo?.full_name !== REPOSITORY ||
    pr.base?.ref !== context.baseBranch ||
    pr.base.repo?.full_name !== REPOSITORY ||
    !pr.body?.startsWith(context.marker + '\n')
  )
    throw new Error('Auxiliary PR identity or ownership mismatch')
  positiveId(pr.number)
  if (
    !['open', 'closed'].includes(pr.state) ||
    (pr.state === 'open' && pr.draft !== true) ||
    (!allowClosed && pr.state !== 'open')
  )
    throw new Error('Auxiliary analysis must remain an open draft PR')
  return pr
}

export async function findAnalysisPr(api, context, { allowClosed = false } = {}) {
  const query = new URLSearchParams({
    head: `bsv-blockchain:${context.branch}`,
    base: context.baseBranch,
    state: allowClosed ? 'all' : 'open',
    per_page: '100'
  })
  const prs = await api(`/pulls?${query}`)
  if (!Array.isArray(prs) || prs.length >= 100) throw new Error('Incomplete auxiliary PR inventory')
  const matches = prs.filter(pr => pr.body?.startsWith(context.marker + '\n'))
  if (matches.length > 1) throw new Error('Ambiguous auxiliary analysis PR')
  if (prs.some(pr => pr.state === 'open' && !matches.includes(pr)))
    throw new Error('Auxiliary branch has an unowned PR')
  return matches.length === 0 ? null : assertAnalysisPr(matches[0], context, { allowClosed })
}
