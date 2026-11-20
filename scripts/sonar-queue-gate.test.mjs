import assert from 'node:assert/strict'
import test from 'node:test'
import { enforceSonarQueueGate, queueBranch } from './sonar-queue-gate.mjs'

const SHA = '1234567890abcdef1234567890abcdef12345678'
const BRANCH = queueBranch(SHA)

function fixture(overrides = {}) {
  const calls = []
  let branchReads = 0
  const analysis = {
    name: BRANCH,
    isMain: false,
    type: 'SHORT',
    commit: { sha: SHA },
    analysisDate: '2026-11-20T20:00:00+0000'
  }
  const dependencies = {
    log() {},
    sleep: async () => {},
    now: () => 0,
    fetchImpl: async url => {
      calls.push(url)
      assert.equal(url.origin, 'https://sonarcloud.io')
      let payload
      if (url.pathname === '/api/project_branches/list') {
        payload = { branches: [overrides.analysis?.(++branchReads, analysis) ?? analysis] }
      } else {
        assert.equal(url.searchParams.get('branch'), BRANCH)
        assert.equal(url.searchParams.has('pullRequest'), false)
        if (url.pathname === '/api/qualitygates/project_status')
          payload = { projectStatus: { status: overrides.quality ?? 'OK' } }
        else if (url.pathname === '/api/issues/search') {
          assert.equal(
            url.searchParams.get('issueStatuses'),
            'OPEN,CONFIRMED,ACCEPTED,FALSE_POSITIVE'
          )
          payload = overrides.issues?.(Number(url.searchParams.get('p'))) ?? {
            paging: { total: 0 },
            issues: []
          }
        } else if (url.pathname === '/api/hotspots/search') {
          assert.equal(url.searchParams.get('status'), 'TO_REVIEW')
          payload = overrides.hotspots ?? { paging: { total: 0 }, hotspots: [] }
        } else throw new Error('Unexpected endpoint')
      }
      return new Response(JSON.stringify(payload), { status: 200 })
    }
  }
  return { calls, dependencies }
}

test('queue gate accepts only a stable exact queue analysis with complete zero findings', async () => {
  const { calls, dependencies } = fixture()
  const result = await enforceSonarQueueGate(SHA, dependencies)
  assert.equal(result.revision, SHA)
  assert.equal(result.issueCount, 0)
  assert.equal(result.hotspotCount, 0)
  assert.equal(calls.filter(url => url.pathname === '/api/project_branches/list').length, 2)
})

test('queue identity rejects malformed revisions', () => {
  for (const value of ['', 'main', SHA.toUpperCase(), SHA + 'x', SHA + '\n', undefined]) {
    assert.throws(() => queueBranch(value), /full lowercase commit SHA/)
  }
})

test('queue gate waits for its exact revision and never accepts a PR result', async () => {
  const { dependencies } = fixture({
    analysis: (read, analysis) =>
      read === 1 ? { ...analysis, commit: { sha: '0'.repeat(40) } } : analysis
  })
  let waits = 0
  dependencies.sleep = async () => {
    waits++
  }
  await enforceSonarQueueGate(SHA, dependencies)
  assert.equal(waits, 1)
})

test('queue gate fails when the exact analysis never appears', async () => {
  const { dependencies } = fixture({
    analysis: (_, analysis) => ({ ...analysis, commit: { sha: '0'.repeat(40) } })
  })
  let time = 0
  dependencies.now = () => time
  dependencies.sleep = async () => {
    time += 600000
  }
  await assert.rejects(enforceSonarQueueGate(SHA, dependencies), /Timed out/)
})

test('queue gate rejects main, long-lived, incomplete and changing analysis identities', async () => {
  for (const change of [{ isMain: true }, { type: 'LONG' }, { analysisDate: undefined }]) {
    const { dependencies } = fixture({ analysis: (_, analysis) => ({ ...analysis, ...change }) })
    await assert.rejects(enforceSonarQueueGate(SHA, dependencies), /completed short-lived/)
  }
  const { dependencies } = fixture({
    analysis: (read, analysis) =>
      read > 1 ? { ...analysis, analysisDate: '2026-11-20T20:01:00+0000' } : analysis
  })
  await assert.rejects(enforceSonarQueueGate(SHA, dependencies), /changed while collecting/)
})

test('quality failure, accepted findings, false positives and unreviewed hotspots all block', async () => {
  const cases = [
    { quality: 'ERROR' },
    ...['OPEN', 'CONFIRMED', 'ACCEPTED', 'FALSE_POSITIVE', 'UNKNOWN'].map(issueStatus => ({
      issues: () => ({ total: 1, issues: [{ key: 'finding', issueStatus }] })
    })),
    { hotspots: { total: 1, hotspots: [{ key: 'hotspot' }] } }
  ]
  for (const options of cases)
    await assert.rejects(enforceSonarQueueGate(SHA, fixture(options).dependencies), /gate failed/)
})

test('complete pagination detects findings beyond the first page', async () => {
  let pages = 0
  const issues = page => {
    pages++
    return {
      total: 501,
      issues: Array.from({ length: page === 1 ? 500 : 1 }, (_, index) => ({
        key: `${page}-${index}`
      }))
    }
  }
  await assert.rejects(
    enforceSonarQueueGate(SHA, fixture({ issues }).dependencies),
    /newFindings=501/
  )
  assert.equal(pages, 2)
})

test('truncated, duplicate, malformed and changing inventories fail closed', async () => {
  const cases = [
    () => ({ issues: [] }),
    () => ({ total: 1, issues: [] }),
    () => ({ total: 1, issues: [{ key: 'a' }, { key: 'b' }] }),
    () => ({ total: 2, issues: [{ key: 'a' }, { key: 'a' }] }),
    () => ({ total: 1, issues: [{}] }),
    page => ({ total: page === 1 ? 2 : 1, issues: [{ key: String(page) }] }),
    () => ({ paging: { total: 0, pageIndex: 2 }, issues: [] })
  ]
  for (const issues of cases)
    await assert.rejects(enforceSonarQueueGate(SHA, fixture({ issues }).dependencies), /inventory/)
})

test('API failure cannot produce a passing result', async () => {
  const { dependencies } = fixture()
  dependencies.fetchImpl = async () => new Response('', { status: 503 })
  await assert.rejects(enforceSonarQueueGate(SHA, dependencies), /HTTP 503/)
})
