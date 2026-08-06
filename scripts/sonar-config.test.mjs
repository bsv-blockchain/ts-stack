import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { REPOSITORY_ROOT } from './repository-health.mjs'

const AUTOMATIC_CONFIG_PATH = join(REPOSITORY_ROOT, '.sonarcloud.properties')
const PROJECTS_PATH = join(REPOSITORY_ROOT, 'governance/repository-health/projects.json')

function readProperty(source, key) {
  const prefix = `${key}=`
  const line = source.split('\n').find(candidate => candidate.startsWith(prefix))
  assert.ok(line, `${key} is missing`)
  return line.slice(prefix.length).split(',').filter(Boolean)
}

function patternMatchesPath(pattern, path) {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**', '\u0000')
    .replaceAll('*', '[^/]*')
    .replaceAll('\u0000', '.*')
  return new RegExp(`^${escaped}$`).test(path)
}

test('Sonar Automatic Analysis excludes governed generated outputs but analyzes owned copies', () => {
  const config = readFileSync(AUTOMATIC_CONFIG_PATH, 'utf8')
  const registry = JSON.parse(readFileSync(PROJECTS_PATH, 'utf8'))
  const issueExclusions = readProperty(config, 'sonar.exclusions')
  const duplicationExclusions = readProperty(config, 'sonar.cpd.exclusions')
  const trackedPaths = execFileSync('git', ['ls-files'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8'
  })
    .trim()
    .split('\n')
    .filter(Boolean)
  const synchronizedCopies = registry.generatedArtifacts.filter(artifact =>
    artifact.generator.startsWith('scripts/sync-service-')
  )
  const externallyGenerated = registry.generatedArtifacts.filter(
    artifact => !synchronizedCopies.includes(artifact)
  )

  for (const artifact of externallyGenerated) {
    const generatedPaths = trackedPaths.filter(path => patternMatchesPath(artifact.path, path))
    assert.notEqual(generatedPaths.length, 0, `generated boundary ${artifact.path} must own files`)
    for (const generatedPath of generatedPaths) {
      assert.ok(
        issueExclusions.some(pattern => patternMatchesPath(pattern, generatedPath)),
        `Sonar must exclude generated output ${generatedPath}`
      )
    }
  }
  for (const artifact of synchronizedCopies) {
    assert.ok(
      !issueExclusions.some(pattern => patternMatchesPath(pattern, artifact.path)),
      `Sonar must analyze synchronized owned source ${artifact.path}`
    )
    assert.ok(
      duplicationExclusions.includes(artifact.path),
      `Sonar must suppress only intentional duplication for ${artifact.path}`
    )
  }

  assert.ok(
    !issueExclusions.some(pattern => pattern === '**/*.ts' || pattern === '**/docs-site/**'),
    'Automatic Analysis must not broadly exclude authored TypeScript or the docs site'
  )
})
