import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'
import { selectedMutationPartition } from './mutation-partitions.mjs'
import { REPOSITORY_ROOT } from './repository-health.mjs'

export function mutationFinding(environment) {
  const target = environment.MUTATION_AUDIT_TARGET
  const partition = environment.MUTATION_AUDIT_PARTITION
  const repository = environment.GITHUB_REPOSITORY
  assert.match(target ?? '', /^[a-z0-9-]{1,100}$/)
  assert.match(partition ?? '', /^[a-z0-9-]{1,100}$/)
  assert.match(repository ?? '', /^[\w.-]+\/[\w.-]+$/)
  assert.match(environment.GITHUB_SHA ?? '', /^[a-f\d]{40}$/)
  assert.match(environment.GITHUB_RUN_ID ?? '', /^[1-9]\d*$/)
  assert.match(environment.GITHUB_RUN_ATTEMPT ?? '', /^[1-9]\d*$/)
  const result = environment.MUTATION_AUDIT_RESULT
  assert(['success', 'failure', 'cancelled', 'skipped'].includes(result))
  const url = `https://github.com/${repository}/actions/runs/${environment.GITHUB_RUN_ID}/attempts/${environment.GITHUB_RUN_ATTEMPT}`
  return {
    repository,
    title: `Mutation audit: ${target}/${partition}`,
    needsTriage: result !== 'success',
    body: `Background audit result: ${result}.\n\nTarget: ${target}/${partition}\nSource: ${environment.GITHUB_SHA}\nEvidence: ${url}\n\nThis is advisory evidence and cannot block development, merge, publication or deployment. A failed or interrupted audit needs triage; it is not proof of a product defect. Preserve raw outcomes and reproduce any actual defect with a focused regression. Report suspected vulnerabilities privately under the security policy. No raw failure payload is published in this issue.\n`
  }
}

export function publishMutationFinding(
  environment,
  runGh = args => execFileSync('gh', args, { encoding: 'utf8' })
) {
  const finding = mutationFinding(environment)
  if (environment.GITHUB_STEP_SUMMARY)
    appendFileSync(
      environment.GITHUB_STEP_SUMMARY,
      `### Background mutation audit\n\n${finding.body}`
    )
  if (!finding.needsTriage) return { created: false }
  const matches = JSON.parse(
    runGh([
      'issue',
      'list',
      '--repo',
      finding.repository,
      '--state',
      'open',
      '--search',
      finding.title,
      '--limit',
      '100',
      '--json',
      'number,title'
    ])
  )
  const existing = matches.find(issue => issue.title === finding.title)
  const directory = mkdtempSync(join(tmpdir(), 'mutation-finding-'))
  try {
    const body = join(directory, 'body.md')
    writeFileSync(body, finding.body)
    const args = existing
      ? ['issue', 'comment', String(existing.number), '--repo', finding.repository]
      : ['issue', 'create', '--repo', finding.repository, '--title', finding.title]
    runGh([...args, '--body-file', body])
    return { created: !existing }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'validate') {
    const target = process.env.MUTATION_AUDIT_TARGET
    const configured = buildMutationTargets(REPOSITORY_ROOT)[target]
    assert(configured, 'Select one exact governed target')
    selectedMutationPartition(target, configured, process.env.MUTATION_AUDIT_PARTITION)
  } else {
    assert.equal(process.argv[2], 'report')
    publishMutationFinding(process.env)
  }
}
