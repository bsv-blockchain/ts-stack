import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { enforceSonarPullRequestGate, parseArguments } from './sonar-pr-gate.mjs'
import { REPOSITORY_ROOT } from './repository-health.mjs'

const REVISION = '1234567890abcdef1234567890abcdef12345678'

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

function sonarFetch({ revisions = [REVISION], quality = 'OK', issues = 0, hotspots = 0 }) {
  let analysisRequest = 0
  const calls = []
  const fetchImpl = async input => {
    const url = new URL(input)
    calls.push(url)
    if (url.pathname === '/api/project_pull_requests/list') {
      const revision = revisions[Math.min(analysisRequest, revisions.length - 1)]
      analysisRequest++
      return jsonResponse({
        pullRequests: [{ key: '385', commit: { sha: revision } }]
      })
    }
    if (url.pathname === '/api/qualitygates/project_status') {
      return jsonResponse({ projectStatus: { status: quality } })
    }
    if (url.pathname === '/api/issues/search') {
      return jsonResponse({ paging: { total: issues } })
    }
    if (url.pathname === '/api/hotspots/search') {
      return jsonResponse({ paging: { total: hotspots } })
    }
    throw new Error(`Unexpected SonarCloud API path: ${url.pathname}`)
  }
  return { fetchImpl, calls }
}

function options() {
  return {
    baseUrl: 'https://sonarcloud.example',
    project: 'bsv-blockchain_ts-stack',
    pullRequest: 385,
    revision: REVISION,
    timeoutMs: 1000,
    pollMs: 1
  }
}

test('argument parsing requires an exact revision and positive identifiers', () => {
  assert.deepEqual(
    parseArguments([
      '--project',
      'bsv-blockchain_ts-stack',
      '--pull-request',
      '385',
      '--revision',
      REVISION
    ]),
    {
      baseUrl: 'https://sonarcloud.io',
      timeoutMs: 600000,
      pollMs: 15000,
      project: 'bsv-blockchain_ts-stack',
      pullRequest: 385,
      revision: REVISION
    }
  )
  assert.throws(
    () =>
      parseArguments([
        '--project',
        'bsv-blockchain_ts-stack',
        '--pull-request',
        '0',
        '--revision',
        REVISION
      ]),
    /positive integer/
  )
  assert.throws(
    () =>
      parseArguments([
        '--project',
        'bsv-blockchain_ts-stack',
        '--pull-request',
        '385',
        '--revision',
        'abc'
      ]),
    /full 40-character commit SHA/
  )
})

test('the gate waits for the exact PR head before evaluating findings', async () => {
  const { fetchImpl, calls } = sonarFetch({
    revisions: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', REVISION]
  })
  const logs = []
  const result = await enforceSonarPullRequestGate(options(), {
    fetchImpl,
    sleep: async () => {},
    log: message => logs.push(message)
  })

  assert.equal(result.revision, REVISION)
  assert.equal(calls.filter(url => url.pathname === '/api/project_pull_requests/list').length, 2)
  assert.match(logs[0], /last observed a{40}/)
})

test('a passing Sonar quality gate cannot hide new issues', async () => {
  const { fetchImpl } = sonarFetch({ quality: 'OK', issues: 2 })
  await assert.rejects(
    enforceSonarPullRequestGate(options(), { fetchImpl, log: () => {} }),
    /2 open or confirmed issue\(s\), expected 0/
  )
})

test('a passing Sonar quality gate cannot hide unreviewed hotspots', async () => {
  const { fetchImpl } = sonarFetch({ quality: 'OK', hotspots: 1 })
  await assert.rejects(
    enforceSonarPullRequestGate(options(), { fetchImpl, log: () => {} }),
    /1 unreviewed security hotspot\(s\), expected 0/
  )
})

test('the gate requires both the quality policy and zero findings', async () => {
  const { fetchImpl } = sonarFetch({ quality: 'ERROR' })
  await assert.rejects(
    enforceSonarPullRequestGate(options(), { fetchImpl, log: () => {} }),
    /quality gate status is ERROR, expected OK/
  )
})

test('CI makes the zero-findings job part of the existing merge gate', () => {
  const workflow = readFileSync(join(REPOSITORY_ROOT, '.github/workflows/ci.yml'), 'utf8')
  assert.match(workflow, /^  sonar-zero-findings:\n    name: SonarCloud zero findings$/m)
  assert.match(workflow, /^      - sonar-zero-findings$/m)
  assert.match(workflow, /SONAR_RESULT: \$\{\{ needs\.sonar-zero-findings\.result \}\}/)
})
