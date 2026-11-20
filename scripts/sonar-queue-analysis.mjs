import { pathToFileURL } from 'node:url'
import {
  REPOSITORY,
  assertActiveQueue,
  assertAnalysisPr,
  findAnalysisPr,
  githubClient,
  queueContext
} from './sonar-queue-context.mjs'

export async function createAnalysisPr(api, context) {
  await assertActiveQueue(api, context)
  const existing = await findAnalysisPr(api, context)
  if (existing) return existing
  const refPath = `/git/ref/heads/${context.branch}`
  const ref = await api(refPath, { allowMissing: true })
  if (ref && ref.object?.sha !== context.sha)
    throw new Error('Refusing to overwrite an auxiliary ref')
  if (!ref)
    await api('/git/refs', {
      method: 'POST',
      body: { ref: `refs/heads/${context.branch}`, sha: context.sha }
    })
  await assertActiveQueue(api, context)
  const pr = await api('/pulls', {
    method: 'POST',
    body: {
      title: `Analysis only: queued commit ${context.sha.slice(0, 12)}`,
      head: context.branch,
      base: context.baseBranch,
      draft: true,
      body:
        `${context.marker}\n\n` +
        'Temporary Sonar analysis of the exact combined queue commit. Do not merge, edit, or approve workflows on this draft.\n\n' +
        `Queue CI: https://github.com/${REPOSITORY}/actions/runs/${context.runId}\n\n` +
        'Automatic Analysis supplies the genuine Sonar app check. The queue CI independently enforces zero findings and hotspots. ' +
        'The trusted controller closes this draft and removes its branch when that CI run completes. ' +
        'No review, publication, deployment, or protection bypass is requested.'
    }
  })
  return assertAnalysisPr(pr, context)
}

export async function cleanupAnalysisPr(api, context) {
  const pr = await findAnalysisPr(api, context, { allowClosed: true })
  // No owned PR means no authority to delete a possibly unrelated branch.
  if (!pr) return
  if (pr.state === 'open') {
    await api(`/pulls/${pr.number}`, { method: 'PATCH', body: { state: 'closed' } })
    const closed = assertAnalysisPr(await api(`/pulls/${pr.number}`), context, {
      allowClosed: true
    })
    if (closed.state !== 'closed') throw new Error('Auxiliary PR did not close')
  }
  const ref = await api(`/git/ref/heads/${context.branch}`, { allowMissing: true })
  if (!ref) return
  if (ref.object?.sha !== context.sha) throw new Error('Refusing to delete a changed auxiliary ref')
  await api(`/git/refs/heads/${context.branch}`, { method: 'DELETE' })
  if (await api(`/git/ref/heads/${context.branch}`, { allowMissing: true }))
    throw new Error('Auxiliary ref deletion did not persist')
}

export async function handleWorkflowRun(event, api, baseBranch = 'main') {
  if (
    event.repository?.full_name !== REPOSITORY ||
    !['in_progress', 'completed'].includes(event.action)
  )
    throw new Error('Unexpected controller event')
  const advertised = queueContext(event.workflow_run, baseBranch)
  const run = await api(`/actions/runs/${advertised.runId}`)
  const current = queueContext(run, baseBranch)
  if (JSON.stringify(current) !== JSON.stringify(advertised)) return { stale: true }
  if (event.action === 'completed') {
    if (run.status !== 'completed') return { stale: true }
    await cleanupAnalysisPr(api, current)
    return { cleaned: true, revision: current.sha }
  }
  if (run.status !== 'in_progress') return { stale: true }
  const pr = await createAnalysisPr(api, current)
  return { pullRequest: pr.number, revision: current.sha }
}

export function eventFromEnvironment(env) {
  if (env.GITHUB_EVENT_NAME !== 'workflow_run' || env.GITHUB_REPOSITORY !== REPOSITORY)
    throw new Error('Expected this repository workflow_run event')
  const repository = { full_name: REPOSITORY }
  return {
    repository,
    action: env.QUEUE_ACTION,
    workflow_run: {
      id: Number(env.QUEUE_RUN_ID),
      run_attempt: Number(env.QUEUE_RUN_ATTEMPT),
      head_sha: env.QUEUE_REVISION,
      head_branch: env.QUEUE_REF,
      event: 'merge_group',
      path: '.github/workflows/ci.yml',
      repository,
      head_repository: repository
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(
      JSON.stringify(
        await handleWorkflowRun(
          eventFromEnvironment(process.env),
          githubClient(process.env.GITHUB_TOKEN)
        )
      )
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
