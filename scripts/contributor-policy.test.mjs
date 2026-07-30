import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  REPOSITORY_ROOT,
  evaluateContributorPolicy,
  governedScopePaths,
  renderPackageAgentPointer
} from './contributor-policy.mjs'

test('current contributor and agent policy is uniform across the governed stack', () => {
  const result = evaluateContributorPolicy()
  assert.deepEqual(result.errors, [])
  assert.equal(result.summary.scopedProjectsAndServices, 43)
  assert.equal(result.summary.consolidatedLegacyAgentFiles, 31)
  assert.equal(result.summary.historicalGitHubFiles, 49)
  assert.equal(result.summary.retiredPackageContributionFiles, 8)
})

test('governed scopes combine workspace projects and standalone services exactly once', () => {
  assert.deepEqual(
    governedScopePaths(
      {
        projects: [{ path: '.' }, { path: 'packages/example' }, { path: 'infra/shared' }]
      },
      {
        services: [{ path: 'infra/shared' }, { path: 'infra/service' }]
      }
    ),
    ['infra/service', 'infra/shared', 'packages/example']
  )
})

test('package pointers lead to root policy without defining local conventions', () => {
  assert.equal(
    renderPackageAgentPointer('packages/wallet/example'),
    `# ts-stack agent instructions

This project follows the repository-wide [agent instructions](../../../AGENTS.md)
and [contribution policy](../../../CONTRIBUTING.md). Read and follow both files
before changing anything in this directory.

Do not add package-local agent or contribution conventions. Put
package-specific technical information in the package README, \`docs/\`,
\`specs/\`, or the applicable operator guide, and propose shared policy at the
repository root.
`
  )
})

test('the repository root remains the executable policy authority', () => {
  for (const relativePath of [
    'AGENTS.md',
    'CONTRIBUTING.md',
    'CODE_OF_CONDUCT.md',
    '.github/pull_request_template.md',
    'governance/contributor-policy.json'
  ]) {
    assert.equal(
      fs.existsSync(path.join(REPOSITORY_ROOT, relativePath)),
      true,
      `${relativePath} must exist`
    )
  }
})

test('a nested policy file or GitHub directory is rejected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-stack-contributor-policy-'))
  try {
    for (const relativePath of [
      'AGENTS.md',
      'CONTRIBUTING.md',
      'CODE_OF_CONDUCT.md',
      '.github/SECURITY.md',
      '.github/pull_request_template.md',
      '.github/ISSUE_TEMPLATE'
    ]) {
      const target = path.join(root, relativePath)
      if (relativePath.endsWith('ISSUE_TEMPLATE')) {
        fs.mkdirSync(target, { recursive: true })
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(
          target,
          'exact-head zero new Sonar findings CodeQL self-review Documentation, changelog, migration Review conversations are resolved all applicable checks'
        )
      }
    }
    fs.mkdirSync(path.join(root, 'packages/example/.github'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'packages/example/AGENTS.md'),
      renderPackageAgentPointer('packages/example')
    )
    fs.writeFileSync(path.join(root, 'packages/example/CONTRIBUTING.md'), 'local rules')

    const result = evaluateContributorPolicy({
      root,
      policy: {
        schemaVersion: 1,
        owner: 'maintainers',
        authority: {
          agentInstructions: 'AGENTS.md',
          contributionGuide: 'CONTRIBUTING.md',
          codeOfConduct: 'CODE_OF_CONDUCT.md',
          securityPolicy: '.github/SECURITY.md',
          pullRequestTemplate: '.github/pull_request_template.md',
          issueTemplateDirectory: '.github/ISSUE_TEMPLATE'
        },
        prohibitedNestedPolicyFiles: [
          'CONTRIBUTING.md',
          'CODE_OF_CONDUCT.md',
          'CLAUDE.md',
          'GEMINI.md',
          '.cursorrules'
        ],
        requiredRootWorkflows: [],
        requiredPullRequestEvidence: [
          'exact-head',
          'zero new Sonar findings',
          'CodeQL',
          'self-review',
          'Documentation, changelog, migration',
          'Review conversations are resolved',
          'all applicable checks'
        ],
        historicalGitHubDispositions: [],
        retiredPackageContributionFiles: []
      },
      projects: { projects: [{ path: '.' }, { path: 'packages/example' }] },
      serviceOperations: { services: [] }
    })

    assert.match(result.errors.join('\n'), /nested GitHub configuration is forbidden/)
    assert.match(result.errors.join('\n'), /package-local contributor policy is forbidden/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
