import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { REPOSITORY_ROOT } from './repository-health.mjs'

const CODEQL_CONFIG_PATH = join(REPOSITORY_ROOT, '.github/codeql/codeql-config.yml')
const CODEQL_WORKFLOW_PATH = join(REPOSITORY_ROOT, '.github/workflows/codeql.yml')
const PROJECTS_PATH = join(REPOSITORY_ROOT, 'governance/repository-health/projects.json')
const CODEQL_ACTION_SHA = 'e4fba868fa4b1b91e1fdab776edc8cfbe6e9fb81'

function matchesGeneratedBoundary (path, boundary) {
  if (boundary.endsWith('/**')) {
    return path.startsWith(boundary.slice(0, -2))
  }
  return path === boundary
}

function readIndentedList (source, key, indentation = 0) {
  const lines = source.split('\n')
  const prefix = `${' '.repeat(indentation)}${key}:`
  const start = lines.findIndex(line => line === prefix)
  assert.notEqual(start, -1, `${key} list is missing`)

  const values = []
  const itemIndentation = indentation + 2
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const currentIndentation = line.length - line.trimStart().length
    if (currentIndentation <= indentation) break
    if (currentIndentation === itemIndentation && line.trimStart().startsWith('- ')) {
      values.push(line.trimStart().slice(2))
    }
  }
  return values
}

test('CodeQL scans the owned source boundary with the security-extended suite', () => {
  const config = readFileSync(CODEQL_CONFIG_PATH, 'utf8')
  const registry = JSON.parse(readFileSync(PROJECTS_PATH, 'utf8'))
  const ownedGeneratedPaths = registry.generatedArtifacts
    .filter(artifact => artifact.analysisPolicy === 'exclude-generated')
    .map(artifact => artifact.path)
    .sort()

  assert.deepEqual(readIndentedList(config, 'queries'), ['uses: security-extended'])
  assert.deepEqual(readIndentedList(config, 'paths-ignore').sort(), ownedGeneratedPaths)
})

test('advanced CodeQL preserves authored languages, events, permissions, and required check names', () => {
  const workflow = readFileSync(CODEQL_WORKFLOW_PATH, 'utf8')
  const registry = JSON.parse(readFileSync(PROJECTS_PATH, 'utf8'))
  const generatedBoundaries = registry.generatedArtifacts
    .filter(artifact => artifact.analysisPolicy === 'exclude-generated')
    .map(artifact => artifact.path)
  const authoredPythonFiles = execFileSync(
    'git',
    ['ls-files', '--', '*.py'],
    { cwd: REPOSITORY_ROOT, encoding: 'utf8' }
  )
    .trim()
    .split('\n')
    .filter(Boolean)
    .filter(path => !generatedBoundaries.some(boundary => matchesGeneratedBoundary(path, boundary)))

  assert.deepEqual(readIndentedList(workflow, 'language', 8), [
    'actions',
    'javascript-typescript'
  ])
  assert.deepEqual(
    authoredPythonFiles,
    [],
    'authored Python requires restoring the Python CodeQL lane'
  )
  assert.match(workflow, /^  push:\n    branches: \[main\]$/m)
  assert.match(workflow, /^  pull_request:\n    branches: \[main\]$/m)
  assert.match(workflow, /^  schedule:\n    - cron: '.+'$/m)
  assert.match(workflow, /^  workflow_dispatch:$/m)
  assert.match(workflow, /^    name: Analyze \(\$\{\{ matrix\.language \}\}\)$/m)
  assert.match(workflow, /^    if: vars\.CODEQL_ADVANCED_ENABLED == 'true'$/m)
  assert.match(workflow, /^      security-events: write$/m)
  assert.match(workflow, /^          build-mode: none$/m)
  assert.match(workflow, /^          config-file: \.\/\.github\/codeql\/codeql-config\.yml$/m)
  assert.match(workflow, new RegExp(`github/codeql-action/init@${CODEQL_ACTION_SHA}`))
  assert.match(workflow, new RegExp(`github/codeql-action/analyze@${CODEQL_ACTION_SHA}`))
})
