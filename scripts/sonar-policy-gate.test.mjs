import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArguments } from './sonar-pr-gate.mjs'
import test from 'node:test'
import {
  evaluateSonarBudget,
  readApprovedSonarBudget,
  SONAR_BUDGET
} from './sonar-pr569-budget.mjs'
import { readReviewedAnalysisExceptions } from './pr569-reviewed-analysis.mjs'
import { enforceRepositorySonarGate } from './sonar-policy-gate.mjs'

const SHA = '1234567890abcdef1234567890abcdef12345678'
const BASE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const NOW = Date.parse('2026-10-18T02:00:00Z')
const clone = value => structuredClone(value)
function issue(key = 'finding-1') {
  return {
    key,
    project: SONAR_BUDGET.project,
    pullRequest: '569',
    type: 'CODE_SMELL',
    issueStatus: 'OPEN',
    impacts: [{ softwareQuality: 'MAINTAINABILITY', severity: 'LOW' }]
  }
}
function snapshot() {
  const analysis = {
    key: '569',
    branch: SONAR_BUDGET.branch,
    base: 'main',
    commit: { sha: SHA },
    analysisDate: '2026-10-18T01:00:00Z'
  }
  return {
    ...SONAR_BUDGET,
    revision: SHA,
    analysisBefore: clone(analysis),
    analysisAfter: clone(analysis),
    issueTotal: 1,
    issues: [issue()],
    hotspotTotal: 0,
    hotspots: [],
    qualityGate: {
      projectStatus: {
        status: 'ERROR',
        ignoredConditions: false,
        conditions: [
          ['new_reliability_rating', 'GT', '1', '1', 'OK'],
          ['new_security_rating', 'GT', '1', '1', 'OK'],
          ['new_maintainability_rating', 'GT', '1', '1', 'OK'],
          ['new_duplicated_lines_density', 'GT', '3', '5.3', 'ERROR'],
          ['new_security_hotspots_reviewed', 'LT', '100', '100.0', 'OK']
        ].map(([metricKey, comparator, errorThreshold, actualValue, status]) => ({
          metricKey,
          comparator,
          errorThreshold,
          actualValue,
          status
        }))
      }
    }
  }
}
function context() {
  const pr = {
    number: 569,
    state: 'open',
    head: { ref: SONAR_BUDGET.branch, sha: SHA, repo: { full_name: SONAR_BUDGET.repository } },
    base: { ref: 'main', sha: BASE, repo: { full_name: SONAR_BUDGET.repository } }
  }
  return {
    pr,
    event: {
      number: 569,
      repository: { full_name: SONAR_BUDGET.repository },
      pull_request: clone(pr)
    },
    env: {
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_REPOSITORY: SONAR_BUDGET.repository,
      GITHUB_REF: 'refs/pull/569/merge',
      GITHUB_HEAD_REF: SONAR_BUDGET.branch,
      GITHUB_BASE_REF: 'main',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_API_URL: 'https://api.github.com',
      GITHUB_EVENT_PATH: '/actions/event.json',
      GITHUB_TOKEN: 'fixture-read-token'
    }
  }
}
function fixture(change = () => {}) {
  const c = context(),
    s = snapshot(),
    saved = {},
    calls = [],
    logs = []
  const f = { c, s, saved, calls, logs, githubCalls: 0, analysisCalls: 0 }
  change(f)
  const fetchImpl = async (input, init) => {
    const url = new URL(input)
    calls.push({ url, init })
    let payload
    if (url.hostname === 'api.github.com') {
      assert.equal(url.pathname, '/repos/bsv-blockchain/ts-stack/pulls/569')
      payload = clone(c.pr)
      f.githubCalls++
      if (f.changeAfterPR && f.githubCalls === 2) f.changeAfterPR(payload)
    } else {
      assert.equal(init.headers.authorization, undefined)
      switch (url.pathname) {
        case '/api/project_pull_requests/list': {
          f.analysisCalls++
          const analysis = clone(f.analysisCalls === 1 ? s.analysisBefore : s.analysisAfter)
          payload = { pullRequests: [analysis] }
          break
        }
        case '/api/qualitygates/project_status':
          payload = clone(s.qualityGate)
          break
        case '/api/issues/search': {
          const p = Number(url.searchParams.get('p'))
          const records = s.issues.slice((p - 1) * 500, p * 500)
          payload = { paging: { total: s.issueTotal, pageIndex: p }, issues: records }
          if (f.changePage) f.changePage(payload, p)
          break
        }
        case '/api/hotspots/search':
          payload = { paging: { total: s.hotspotTotal }, hotspots: s.hotspots }
          break
        default:
          throw new Error(`Unexpected API ${url}`)
      }
    }
    if (f.errorPath === url.pathname) return new Response('', { status: 503 })
    return new Response(JSON.stringify(payload), { status: 200 })
  }
  f.options = {
    baseUrl: 'https://sonarcloud.io',
    project: SONAR_BUDGET.project,
    pullRequest: 569,
    revision: SHA,
    timeoutMs: 100,
    pollMs: 1
  }
  f.dependencies = {
    env: c.env,
    now: () => NOW,
    fetchImpl,
    readEvent: async () => clone(c.event),
    persist: async (name, payload) => {
      saved[name] = clone(payload)
    },
    summary: async text => {
      f.summary = text
    },
    log: text => logs.push(text),
    sleep: async () => {}
  }
  return f
}
async function run(f) {
  return await enforceRepositorySonarGate(f.options, f.dependencies)
}
function rejectsSnapshot(change, pattern) {
  const s = snapshot()
  change(s)
  const result = evaluateSonarBudget(s, NOW)
  assert.equal(result.scopedBudgetSatisfied, false)
  assert.match(result.failures.join('\n'), pattern)
  return result
}

test('approved manifest matches the exact immutable policy and keeps removal criteria', () => {
  const manifest = readApprovedSonarBudget()
  for (const [key, value] of Object.entries(SONAR_BUDGET)) assert.equal(manifest[key], value)
  assert.match(manifest.removalCondition, /strict policy/)
})

test('maintainability-only debt and duplication at six percent pass only the scoped verdict', async () => {
  const f = fixture()
  f.s.qualityGate.projectStatus.conditions[3].actualValue = '6'
  const result = await run(f)
  assert.equal(result.scopedBudgetSatisfied, true)
  assert.equal(result.originalZeroFindingsSatisfied, false)
  assert.equal(result.maintainabilityFindings, 1)
  assert.equal(f.githubCalls, 2)
  assert.equal(f.analysisCalls, 2)
  for (const name of [
    'github-pr-before',
    'github-pr-after',
    'sonar-analysis-after',
    'sonar-issues-page-1',
    'sonar-hotspots-page-1',
    'snapshot',
    'verdict'
  ])
    assert.ok(f.saved[name])
  assert.match(f.summary, /Original zero-findings verdict: FAIL/)
  assert.match(f.summary, /Approved PR569 budget verdict: PASS/)
  assert.ok(!JSON.stringify(f.saved).includes('fixture-read-token'))
  assert.equal(
    f.calls.find(c => c.url.hostname === 'api.github.com').init.headers.authorization,
    'Bearer fixture-read-token'
  )
  assert.equal(
    f.calls
      .find(c => c.url.pathname === '/api/issues/search')
      .url.searchParams.get('issueStatuses'),
    'OPEN,CONFIRMED,ACCEPTED,FALSE_POSITIVE,FIXED'
  )
})

test('complete multi-page inventories retain all fixed and active records', async () => {
  const f = fixture()
  f.s.issues = Array.from({ length: 501 }, (_, i) => issue(`finding-${i}`))
  f.s.issues[500].issueStatus = 'FIXED'
  f.s.issues[500].type = 'BUG'
  f.s.issueTotal = 501
  const result = await run(f)
  assert.equal(result.activeFindings, 500)
  assert.equal(f.saved.snapshot.issues.length, 501)
  assert.equal(f.saved['sonar-issues-page-2'].issues[0].key, 'finding-500')
})

test('every out-of-scope Actions context keeps the original strict gate', async () => {
  for (const [key, value] of Object.entries({
    GITHUB_ACTIONS: 'false',
    GITHUB_EVENT_NAME: 'pull_request_target',
    GITHUB_REPOSITORY: 'other/repo',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_HEAD_REF: 'other',
    GITHUB_BASE_REF: 'other',
    GITHUB_SERVER_URL: 'https://other.example',
    GITHUB_API_URL: 'https://other.example'
  })) {
    const f = fixture()
    f.c.env[key] = value
    await assert.rejects(run(f), /zero-findings gate failed/, key)
    assert.equal(f.githubCalls, 0, key)
    assert.deepEqual(f.saved, {}, key)
  }
  const f = fixture()
  f.dependencies.env = {}
  await assert.rejects(run(f), /zero-findings gate failed/)
  assert.equal(f.githubCalls, 0)
})

test('expired approval automatically invokes the original strict gate', async () => {
  for (const at of ['2026-10-24T23:59:59Z', '2026-10-25T00:00:00Z']) {
    const f = fixture()
    f.dependencies.now = () => Date.parse(at)
    await assert.rejects(run(f), /zero-findings gate failed/)
    assert.equal(f.githubCalls, 0)
    assert.deepEqual(f.saved, {})
  }
})

test('another project or PR cannot use the exception', async () => {
  const f = fixture()
  f.options.project = 'other'
  await assert.rejects(run(f), /zero-findings gate failed/)
  assert.equal(f.githubCalls, 0)
  // A distinct real PR analysis is consumed by the original implementation.
  const other = fixture()
  other.options.pullRequest = 674
  other.dependencies.fetchImpl = async input => {
    const path = new URL(input).pathname
    const payload = path.includes('project_pull_requests')
      ? { pullRequests: [{ key: '674', commit: { sha: SHA } }] }
      : path.includes('project_status')
        ? { projectStatus: { status: 'OK' } }
        : path.includes('issues/search')
          ? { paging: { total: 1 }, issues: [issue()] }
          : { paging: { total: 0 } }
    return new Response(JSON.stringify(payload))
  }
  await assert.rejects(run(other), /1 new issue finding/)
  assert.deepEqual(other.saved, {})
})

test('event/live GitHub fork, branch, base, revision and state mismatches fail closed', async () => {
  const changes = [
    pr => {
      pr.head.sha = BASE
    },
    pr => {
      pr.head.ref = 'other'
    },
    pr => {
      pr.head.repo.full_name = 'fork/ts-stack'
    },
    pr => {
      pr.base.repo.full_name = 'fork/ts-stack'
    },
    pr => {
      pr.base.ref = 'release'
    },
    pr => {
      pr.number = 674
    },
    pr => {
      pr.state = 'closed'
    }
  ]
  for (const change of changes) {
    for (const target of ['pr', 'event']) {
      const f = fixture()
      change(target === 'pr' ? f.c.pr : f.c.event.pull_request)
      await assert.rejects(run(f), /context/)
      assert.ok(f.saved.failure)
      assert.equal(f.saved.verdict, undefined)
    }
  }
})

test('head or base movement during collection cannot produce a verdict', async () => {
  for (const change of [
    pr => {
      pr.head.sha = BASE
    },
    pr => {
      pr.base.sha = SHA
    }
  ]) {
    const f = fixture()
    f.changeAfterPR = change
    await assert.rejects(run(f), /changed while collecting/)
    assert.ok(f.saved['github-pr-after'])
    assert.ok(f.saved.failure)
    assert.equal(f.saved.verdict, undefined)
  }
})

test('analysis revision/date drift, missing or duplicate findings and changing totals fail closed', async () => {
  for (const change of [
    f => {
      f.s.analysisAfter.commit.sha = BASE
    },
    f => {
      f.s.analysisAfter.analysisDate = '2026-10-18T01:01:00Z'
    }
  ]) {
    const f = fixture(change)
    await assert.rejects(run(f), /analysis/)
    assert.equal(f.saved.verdict.scopedBudgetSatisfied, false)
    assert.ok(f.saved.snapshot)
  }
  for (const changePage of [
    (page, p) => {
      if (p === 2) page.paging.total++
    },
    (page, p) => {
      if (p === 2) page.issues[0].key = 'finding-0'
    },
    (page, p) => {
      if (p === 2) page.issues = []
    },
    page => {
      delete page.issues[0].key
    },
    page => {
      page.paging.pageIndex = 2
    }
  ]) {
    const f = fixture()
    f.s.issues = Array.from({ length: 501 }, (_, i) => issue(`finding-${i}`))
    f.s.issueTotal = 501
    f.changePage = changePage
    await assert.rejects(run(f), /inventory/)
    assert.ok(f.saved['sonar-issues-page-1'])
    assert.ok(f.saved.failure)
  }
})

test('bugs, vulnerabilities, unknown/mixed impacts and accepted/false-positive states remain blocking', () => {
  for (const type of ['BUG', 'VULNERABILITY', 'UNKNOWN']) {
    for (const state of ['OPEN', 'CONFIRMED', 'ACCEPTED', 'FALSE_POSITIVE'])
      rejectsSnapshot(s => {
        s.issues[0].type = type
        s.issues[0].issueStatus = state
      }, /correctness\/security/)
  }
  for (const impacts of [
    undefined,
    [],
    [{ softwareQuality: 'RELIABILITY', severity: 'LOW' }],
    [
      { softwareQuality: 'MAINTAINABILITY', severity: 'LOW' },
      { softwareQuality: 'SECURITY', severity: 'HIGH' }
    ],
    [{ softwareQuality: 'UNKNOWN', severity: 'LOW' }],
    [{ softwareQuality: 'MAINTAINABILITY' }]
  ])
    rejectsSnapshot(s => {
      s.issues[0].impacts = impacts
    }, /correctness\/security/)
  rejectsSnapshot(s => {
    s.issues[0].issueStatus = 'UNKNOWN'
  }, /unknown finding state/)
  rejectsSnapshot(s => {
    s.issues[0].project = 'other'
  }, /outside approved project/)
})

test('unreviewed, unknown, incomplete and duplicate hotspots block', () => {
  for (const hotspot of [
    { key: 'h', status: 'TO_REVIEW' },
    { key: 'h', status: 'UNKNOWN' },
    { key: 'h', status: 'REVIEWED' }
  ])
    rejectsSnapshot(s => {
      s.hotspots = [hotspot]
      s.hotspotTotal = 1
    }, /hotspot/)
  rejectsSnapshot(s => {
    s.hotspotTotal = 1
  }, /incomplete hotspot/)
  rejectsSnapshot(s => {
    s.hotspots = [
      { key: 'h', status: 'REVIEWED', resolution: 'SAFE' },
      { key: 'h', status: 'REVIEWED', resolution: 'SAFE' }
    ]
    s.hotspotTotal = 2
  }, /duplicate hotspot/)
  const s = snapshot()
  s.hotspots = [{ key: 'h', status: 'REVIEWED', resolution: 'FIXED' }]
  s.hotspotTotal = 1
  assert.equal(evaluateSonarBudget(s, NOW).scopedBudgetSatisfied, true)
})

test('ratings, duplication boundaries, ignored/missing/malformed/unknown failed conditions block', () => {
  rejectsSnapshot(s => {
    s.qualityGate.projectStatus.conditions[3].actualValue = '6.0001'
  }, /required metric/)
  for (const index of [0, 1, 2, 4])
    rejectsSnapshot(s => {
      s.qualityGate.projectStatus.conditions[index].actualValue = index === 4 ? '99' : '2'
      s.qualityGate.projectStatus.conditions[index].status = 'ERROR'
    }, /required metric/)
  rejectsSnapshot(s => {
    s.qualityGate.projectStatus.ignoredConditions = true
  }, /ignored/)
  rejectsSnapshot(s => {
    s.qualityGate.projectStatus.conditions.pop()
  }, /missing required/)
  rejectsSnapshot(s => {
    s.qualityGate.projectStatus.conditions.push(clone(s.qualityGate.projectStatus.conditions[0]))
  }, /duplicate quality/)
  rejectsSnapshot(s => {
    s.qualityGate.projectStatus.conditions[3].actualValue = ''
  }, /malformed/)
  rejectsSnapshot(s => {
    s.qualityGate.projectStatus.conditions[3].errorThreshold = '7'
  }, /required metric/)
  rejectsSnapshot(s => {
    s.qualityGate.projectStatus.conditions[3].status = 'OK'
  }, /inconsistent/)
  rejectsSnapshot(s => {
    s.qualityGate.projectStatus.status = 'OK'
  }, /aggregate/)
  rejectsSnapshot(s => {
    s.qualityGate.projectStatus.conditions.push({
      metricKey: 'future_metric',
      comparator: 'GT',
      errorThreshold: '1',
      actualValue: '2',
      status: 'ERROR'
    })
  }, /unknown failed/)
})

test('API errors and scoped failures retain raw evidence without hiding the original verdict', async () => {
  const f = fixture()
  f.s.issues[0].type = 'BUG'
  await assert.rejects(run(f), /correctness\/security/)
  assert.equal(f.saved.verdict.originalZeroFindingsSatisfied, false)
  assert.equal(f.saved.verdict.scopedBudgetSatisfied, false)
  assert.equal(f.saved.snapshot.issues[0].type, 'BUG')
  assert.ok(f.saved.failure)
  const failed = fixture()
  failed.errorPath = '/api/issues/search'
  await assert.rejects(run(failed), /HTTP 503/)
  assert.ok(failed.saved['sonar-quality-gate'])
  assert.ok(failed.saved.failure)
})

test('root policies and CI keep the narrow budget visible and preserve every existing dependency', () => {
  for (const path of [
    'AGENTS.md',
    'CONTRIBUTING.md',
    '.github/SECURITY.md',
    '.github/pull_request_template.md'
  ]) {
    const text = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
    assert.match(text, /sonar-pr569-budget/)
    assert.match(text, /6%/)
    assert.match(text, /reliability\/security/)
  }
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  assert.match(workflow, /if: always\(\) && hashFiles\('\.sonar-policy\/\*\*\/\*\.json'\) != ''/)
  assert.match(workflow, /include-hidden-files: true/)
  assert.match(workflow, /SONAR_RESULT: \$\{\{ needs\.sonar-zero-findings\.result \}\}/)
  assert.match(workflow, /^      - sonar-zero-findings$/m)
  const cli = readFileSync(new URL('./sonar-pr-gate.mjs', import.meta.url), 'utf8')
  assert.match(cli, /await enforceRepositorySonarGate\(options\)/)
  assert.ok(!cli.includes('--budget'))
})

test('a truly strict-clean snapshot reports both verdicts as passed', async () => {
  const f = fixture()
  f.s.issues[0].issueStatus = 'FIXED'
  f.s.qualityGate.projectStatus.status = 'OK'
  f.s.qualityGate.projectStatus.conditions[3].actualValue = '3'
  f.s.qualityGate.projectStatus.conditions[3].status = 'OK'
  const result = await run(f)
  assert.equal(result.originalZeroFindingsSatisfied, true)
  assert.equal(result.scopedBudgetSatisfied, true)
})

test('event base disagreement and an approval expiring during collection fail closed', async () => {
  const base = fixture()
  base.c.event.pull_request.base.sha = SHA
  await assert.rejects(run(base), /Live GitHub PR differs/)
  const expiry = fixture()
  let times = 0
  expiry.dependencies.now = () => (++times < 3 ? NOW : Date.parse(SONAR_BUDGET.expiresAt))
  await assert.rejects(run(expiry), /budget expired/)
  assert.equal(expiry.saved.verdict.scopedBudgetSatisfied, false)
})

test('the exact-head wait polls and rejects a bounded timeout', async () => {
  const f = fixture()
  f.s.analysisBefore.commit.sha = BASE
  const result = await run(f)
  assert.equal(result.scopedBudgetSatisfied, true)
  assert.equal(f.analysisCalls, 3)
  const expiredWait = fixture()
  expiredWait.s.analysisBefore.commit.sha = BASE
  expiredWait.s.analysisAfter.commit.sha = BASE
  let tick = NOW
  expiredWait.dependencies.now = () => {
    const value = tick
    tick += 200
    return value
  }
  await assert.rejects(run(expiredWait), /Timed out waiting/)
  assert.ok(expiredWait.saved.failure)
})

test('hotspot pagination and issue totals cannot conceal an incomplete or excess inventory', async () => {
  const f = fixture()
  f.s.hotspotTotal = 1
  await assert.rejects(run(f), /hotspots inventory ended/)
  assert.ok(f.saved['sonar-hotspots-page-1'])
  assert.ok(f.saved.failure)
  const excess = fixture()
  excess.s.issueTotal = 0
  await assert.rejects(run(excess), /exceeded reported total/)
  assert.ok(excess.saved['sonar-issues-page-1'])
})

test('unknown modern status cannot hide behind legacy FIXED fields and numeric strings are decimal', () => {
  rejectsSnapshot(s => {
    Object.assign(s.issues[0], { issueStatus: 'UNKNOWN', status: 'CLOSED', resolution: 'FIXED' })
  }, /unknown finding/)
  for (const value of ['0x6', '6e0', 'NaN', 'Infinity', '-1'])
    rejectsSnapshot(s => {
      s.qualityGate.projectStatus.conditions[3].actualValue = value
    }, /malformed/)
})

test('actual CLI completes module loading and preserves strict pass and failure results', async () => {
  let blocking = false
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    const payloads = {
      '/api/project_pull_requests/list': { pullRequests: [{ key: '385', commit: { sha: SHA } }] },
      '/api/qualitygates/project_status': { projectStatus: { status: 'OK' } },
      '/api/issues/search': {
        paging: { total: blocking ? 1 : 0 },
        issues: blocking ? [{ key: 'bug', type: 'BUG', issueStatus: 'ACCEPTED' }] : []
      },
      '/api/hotspots/search': { paging: { total: 0 } }
    }
    response.writeHead(Object.hasOwn(payloads, path) ? 200 : 404, {
      'content-type': 'application/json'
    })
    response.end(JSON.stringify(payloads[path] ?? {}))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const args = [
      fileURLToPath(new URL('./sonar-pr-gate.mjs', import.meta.url)),
      '--project',
      SONAR_BUDGET.project,
      '--pull-request',
      '385',
      '--revision',
      SHA,
      '--base-url',
      `http://127.0.0.1:${server.address().port}`,
      '--timeout-ms',
      '1000',
      '--poll-ms',
      '1'
    ]
    const run = () =>
      promisify(execFile)(process.execPath, args, {
        timeout: 5000,
        env: { ...process.env, GITHUB_ACTIONS: 'false' }
      })
    const passed = await run()
    assert.match(passed.stdout, /original zero-findings gate/)
    assert.match(passed.stdout, /zero-findings gate passed/)
    assert.equal(passed.stderr, '')
    blocking = true
    await assert.rejects(run(), error => {
      assert.equal(error.code, 1)
      assert.match(error.stderr, /1 new issue finding\(s\), expected 0/)
      assert.doesNotMatch(error.stderr, /unsettled top-level await/)
      return true
    })
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('exact SHA parsing refuses a trailing newline before any artifact path is formed', () => {
  assert.throws(
    () =>
      parseArguments([
        '--project',
        SONAR_BUDGET.project,
        '--pull-request',
        '569',
        '--revision',
        SHA + '\n'
      ]),
    /full 40-character commit SHA/
  )
})

test('real evidence files retain remote JSON as private data and cannot overwrite an earlier collection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sonar-evidence-'))
  const original = process.cwd()
  process.chdir(directory)
  try {
    const f = fixture()
    delete f.dependencies.persist
    f.s.issues[0].key = '../../untrusted-name.js'
    f.s.issues[0].message = '</script>\nRemote text remains JSON data.'
    const verdict = await run(f)
    assert.equal(verdict.scopedBudgetSatisfied, true)
    const root = join(directory, '.sonar-policy', `pr-569-${SHA}`)
    const snapshotBytes = await readFile(join(root, 'snapshot.json'), 'utf8')
    const snapshotData = JSON.parse(snapshotBytes)
    assert.deepEqual(snapshotData.issues, f.s.issues)
    const names = await readdir(root)
    assert.ok(names.includes('snapshot.json') && names.includes('verdict.json'))
    for (const name of names) {
      assert.match(name, /^[a-z0-9-]+\.json$/)
      const info = await stat(join(root, name))
      assert.equal(info.isFile(), true)
      if (process.platform !== 'win32') assert.equal(info.mode & 0o777, 0o600)
      assert.ok(!(await readFile(join(root, name), 'utf8')).includes('fixture-read-token'))
    }
    if (process.platform !== 'win32') assert.equal((await stat(root)).mode & 0o777, 0o700)
    const repeated = fixture()
    delete repeated.dependencies.persist
    await assert.rejects(run(repeated), { code: 'EEXIST' })
    assert.equal(await readFile(join(root, 'snapshot.json'), 'utf8'), snapshotBytes)
    await assert.rejects(stat(join(directory, 'untrusted-name.js')), { code: 'ENOENT' })
  } finally {
    process.chdir(original)
    await rm(directory, { recursive: true, force: true })
  }
})

test('real evidence creation refuses a preexisting file symlink without modifying its target', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sonar-evidence-link-'))
  const original = process.cwd()
  process.chdir(directory)
  try {
    const root = join(directory, '.sonar-policy', `pr-569-${SHA}`)
    await mkdir(root, { recursive: true })
    const target = join(directory, 'retained.json')
    await writeFile(target, 'original evidence')
    await symlink(
      target,
      join(root, 'github-pr-before.json'),
      process.platform === 'win32' ? 'file' : undefined
    )
    const f = fixture()
    delete f.dependencies.persist
    await assert.rejects(run(f), { code: 'EEXIST' })
    assert.equal(await readFile(target, 'utf8'), 'original evidence')
  } finally {
    process.chdir(original)
    await rm(directory, { recursive: true, force: true })
  }
})

const REVIEW_NOW = Date.parse('2026-10-19T18:30:00Z')
function reviewedPermissionSnapshot() {
  const manifest = readReviewedAnalysisExceptions()
  const s = snapshot()
  s.issues = manifest.findings
    .filter(f => f.analyzer === 'Sonar')
    .map(f => ({
      ...clone(f),
      project: manifest.project,
      pullRequest: '569',
      component: `${manifest.project}:${f.file}`,
      issueStatus: 'OPEN'
    }))
  s.issueTotal = s.issues.length
  return s
}

test('only exact reviewed permission findings pass while original findings stay visible', () => {
  const s = reviewedPermissionSnapshot()
  const verdict = evaluateSonarBudget(s, REVIEW_NOW)
  assert.equal(verdict.scopedBudgetSatisfied, true)
  assert.equal(verdict.originalZeroFindingsSatisfied, false)
  assert.equal(verdict.activeFindings, 2)
  assert.equal(verdict.maintainabilityFindings, 0)
  assert.deepEqual(
    verdict.reviewedPermissionFindings,
    s.issues.map(i => i.key)
  )
})

for (const [name, change] of [
  [
    'key',
    i => {
      i.key += '-new'
    }
  ],
  [
    'rule',
    i => {
      i.rule = 'javascript:S9999'
    }
  ],
  [
    'component',
    i => {
      i.component += '.changed'
    }
  ],
  [
    'line',
    i => {
      i.line++
    }
  ],
  [
    'message',
    i => {
      i.message += ' changed'
    }
  ],
  [
    'type',
    i => {
      i.type = 'BUG'
    }
  ],
  [
    'mixed impact',
    i => {
      i.impacts.push({ softwareQuality: 'RELIABILITY', severity: 'LOW' })
    }
  ],
  [
    'severity',
    i => {
      i.impacts[0].severity = 'HIGH'
    }
  ],
  [
    'unknown state',
    i => {
      i.issueStatus = 'UNKNOWN'
    }
  ],
  [
    'project',
    i => {
      i.project += '-other'
    }
  ],
  [
    'PR',
    i => {
      i.pullRequest = '570'
    }
  ]
])
  test(`reviewed permission exception rejects changed ${name}`, () => {
    const s = reviewedPermissionSnapshot()
    change(s.issues[0])
    assert.equal(evaluateSonarBudget(s, REVIEW_NOW).scopedBudgetSatisfied, false)
  })

for (const now of [
  Date.parse('2026-10-19T18:27:59Z'),
  Date.parse('2026-10-24T23:59:59Z'),
  Number.NaN
])
  test(`reviewed permissions fail outside their authorization window: ${now}`, () => {
    assert.equal(
      evaluateSonarBudget(reviewedPermissionSnapshot(), now).scopedBudgetSatisfied,
      false
    )
  })

test('reviewed permissions do not authorize another security finding or another PR', () => {
  const s = reviewedPermissionSnapshot()
  s.issues.push({ ...clone(s.issues[0]), key: 'unreviewed-security' })
  s.issueTotal++
  assert.equal(evaluateSonarBudget(s, REVIEW_NOW).scopedBudgetSatisfied, false)
  const other = reviewedPermissionSnapshot()
  other.pullRequest = 570
  assert.equal(evaluateSonarBudget(other, REVIEW_NOW).scopedBudgetSatisfied, false)
})

test('reviewed source hashes and registry identities fail closed independently of finding status', () => {
  const manifestUrl = new URL(
    '../governance/pr569-reviewed-analysis-exceptions.json',
    import.meta.url
  )
  const original = JSON.parse(readFileSync(manifestUrl, 'utf8'))
  for (const finding of original.findings) {
    assert.throws(
      () =>
        readReviewedAnalysisExceptions((url, encoding) =>
          url.pathname.endsWith('/' + finding.file)
            ? Buffer.from('changed source')
            : readFileSync(url, encoding)
        ),
      /Reviewed analysis source changed/
    )
  }
  for (const change of [
    m => {
      m.owner = 'someone-else'
    },
    m => {
      m.expiresAt = '2027-01-01T00:00:00Z'
    },
    m => {
      m.findings[0].sha256 = '0'.repeat(64)
    },
    m => {
      m.findings.push(clone(m.findings[0]))
    },
    m => {
      m.findings[1].key += '-new'
    }
  ]) {
    const altered = clone(original)
    change(altered)
    assert.throws(
      () =>
        readReviewedAnalysisExceptions((url, encoding) =>
          url.href === manifestUrl.href ? JSON.stringify(altered) : readFileSync(url, encoding)
        ),
      /Invalid reviewed analysis exception/
    )
  }
})

test('only both exact reviewed permission findings explain the original security C metric', () => {
  const s = reviewedPermissionSnapshot()
  const security = s.qualityGate.projectStatus.conditions.find(
    c => c.metricKey === 'new_security_rating'
  )
  security.actualValue = '3'
  security.status = 'ERROR'
  assert.equal(evaluateSonarBudget(s, REVIEW_NOW).scopedBudgetSatisfied, true)
  assert.equal(evaluateSonarBudget(s, REVIEW_NOW).originalZeroFindingsSatisfied, false)
  const one = clone(s)
  one.issues.pop()
  one.issueTotal--
  assert.equal(evaluateSonarBudget(one, REVIEW_NOW).scopedBudgetSatisfied, false)
  for (const rating of ['2', '4', '5']) {
    const changed = clone(s)
    changed.qualityGate.projectStatus.conditions.find(
      c => c.metricKey === 'new_security_rating'
    ).actualValue = rating
    assert.equal(evaluateSonarBudget(changed, REVIEW_NOW).scopedBudgetSatisfied, false)
  }
})
