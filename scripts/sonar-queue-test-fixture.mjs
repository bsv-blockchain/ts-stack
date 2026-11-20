import assert from 'node:assert/strict'
import { BOT_ID, BOT_LOGIN, REPOSITORY, queueContext } from './sonar-queue-context.mjs'

export const SHA = '1234567890abcdef1234567890abcdef12345678'
export const BASE = 'a'.repeat(40)
export const RUN = {
  id: 42,
  run_attempt: 1,
  status: 'in_progress',
  event: 'merge_group',
  path: '.github/workflows/ci.yml',
  repository: { full_name: REPOSITORY },
  head_repository: { full_name: REPOSITORY },
  head_sha: SHA,
  head_branch: `gh-readonly-queue/main/pr-12-${BASE}`
}
export const CONTEXT = queueContext(RUN)
export const PR = {
  number: 71,
  state: 'open',
  draft: true,
  user: { id: BOT_ID, login: BOT_LOGIN },
  head: { sha: SHA, ref: CONTEXT.branch, repo: { full_name: REPOSITORY } },
  base: { ref: 'main', repo: { full_name: REPOSITORY } },
  body: CONTEXT.marker + '\nAnalysis only',
  html_url: `https://github.com/${REPOSITORY}/pull/71`
}

export function queueFixture({ prs = [PR], ref = null } = {}) {
  const state = {
    run: structuredClone(RUN),
    prs: structuredClone(prs),
    ref,
    calls: [],
    queueSha: SHA,
    base: BASE,
    ancestor: true,
    analysis: { key: '71', commit: { sha: SHA }, analysisDate: '2026-11-20T20:00:00+0000' },
    check: {
      id: 91,
      app: { id: 12526 },
      name: 'SonarCloud Code Analysis',
      head_sha: SHA,
      status: 'completed',
      conclusion: 'success',
      details_url: 'https://sonarcloud.io/dashboard?id=bsv-blockchain_ts-stack&pullRequest=71'
    },
    issues: [],
    hotspots: 0,
    quality: 'OK'
  }
  const reads = {
    '/actions/runs/42': () => structuredClone(state.run),
    [`/git/ref/heads/${CONTEXT.queueRef}`]: () => ({ object: { sha: state.queueSha } }),
    '/git/ref/heads/main': () => ({ object: { sha: state.base } }),
    [`/git/ref/heads/${CONTEXT.branch}`]: () => state.ref,
    '/pulls/71': () => structuredClone(state.prs[0])
  }
  const writes = {
    'POST /git/refs': options => {
      state.ref = { object: { sha: options.body.sha } }
      return state.ref
    },
    'POST /pulls': options => {
      state.prs.push({ ...structuredClone(PR), body: options.body.body })
      return structuredClone(state.prs[0])
    },
    'PATCH /pulls/71': options => {
      state.prs[0].state = options.body.state
      return structuredClone(state.prs[0])
    },
    [`DELETE /git/refs/heads/${CONTEXT.branch}`]: () => {
      state.ref = null
      return null
    }
  }
  const query = path => {
    if (path.startsWith('/compare/'))
      return {
        status: state.ancestor ? 'ahead' : 'diverged',
        merge_base_commit: { sha: state.base }
      }
    if (path.startsWith('/pulls?')) return structuredClone(state.prs)
    if (path.startsWith(`/commits/${SHA}/check-runs`))
      return {
        total_count: state.check ? 1 : 0,
        check_runs: state.check ? [structuredClone(state.check)] : []
      }
    throw new Error(`Unexpected GitHub read ${path}`)
  }
  const api = async (path, options = {}) => {
    state.calls.push({ path, ...options })
    const method = options.method ?? 'GET'
    if (method === 'GET') return reads[path] ? reads[path]() : query(path)
    const write = writes[`${method} ${path}`]
    if (!write) throw new Error(`Unexpected GitHub request ${method} ${path}`)
    return write(options)
  }
  const fetchImpl = async input => {
    const url = new URL(input)
    assert.equal(url.origin, 'https://sonarcloud.io')
    let body
    if (url.pathname === '/api/project_pull_requests/list')
      body = { pullRequests: [structuredClone(state.analysis)] }
    else {
      assert.equal(url.searchParams.get('pullRequest'), '71')
      if (url.pathname === '/api/qualitygates/project_status')
        body = { projectStatus: { status: state.quality } }
      else if (url.pathname === '/api/issues/search')
        body = { total: state.issues.length, issues: state.issues }
      else if (url.pathname === '/api/hotspots/search')
        body = { paging: { total: state.hotspots }, hotspots: [] }
      else throw new Error('Unexpected Sonar endpoint')
    }
    return new Response(JSON.stringify(body))
  }
  let time = 0
  const dependencies = {
    api,
    fetchImpl,
    log() {},
    now: () => time,
    sleep: async () => {
      time += 600001
    }
  }
  return { state, api, dependencies }
}
