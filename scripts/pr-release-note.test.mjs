import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  checkReleaseNote,
  currentPullRequestBody,
  parseReleaseNote,
  validateReleaseNote
} from './pr-release-note.mjs'

const projects = [
  { name: '@bsv/sdk', release: 'npm-oidc' },
  { name: '@bsv/paymail', release: 'npm-oidc' },
  { name: '@bsv/ts-stack', release: 'none' }
]
const note = () => ({
  schemaVersion: 1,
  packages: { '@bsv/sdk': 'patch', '@bsv/paymail': 'minor' },
  summary: 'Preserve upload headers and add optional address lookup.',
  migration: 'none'
})
const body = value => `## Release note\n\n\`\`\`release-note\n${JSON.stringify(value)}\n\`\`\`\n`
const env = {
  GITHUB_EVENT_NAME: 'pull_request',
  GITHUB_REPOSITORY: 'bsv-blockchain/ts-stack',
  PR_NUMBER: '123',
  PR_HEAD_SHA: 'a'.repeat(40),
  GH_TOKEN: 'test-only'
}
const pullRequest = () => ({
  number: 123,
  state: 'open',
  base: { ref: 'main', repo: { full_name: env.GITHUB_REPOSITORY } },
  head: { sha: env.PR_HEAD_SHA },
  body: body(note())
})
const response = pr => ({ ok: true, json: async () => pr })

test('valid notes preserve separate impacts, plain text and explicit migration decisions', () => {
  for (const impact of ['patch', 'minor', 'major', 'initial']) {
    const value = note()
    value.packages['@bsv/sdk'] = impact
    value.migration =
      'Enable the new optional lookup when needed. Existing callers require no change.'
    assert.deepEqual(validateReleaseNote(parseReleaseNote(body(value)), projects), [])
  }
  const value = { ...note(), packages: 'none' }
  assert.deepEqual(validateReleaseNote(parseReleaseNote(body(value)), projects), [])
  assert.deepEqual(parseReleaseNote(body(value).replaceAll('\n', '\r\n')), value)
})

test('missing, hidden, nested, duplicate, incomplete and malformed blocks fail', () => {
  for (const description of [
    undefined,
    null,
    '',
    'No release needed',
    'x'.repeat(65537),
    `<!--\n${body(note())}-->`,
    `\`\`\`\`markdown\n${body(note())}\`\`\`\``,
    body(note()) + body(note()),
    body(note()).replace(/```\n$/, ''),
    '```release-note\n{"schemaVersion":1,}\n```',
    '```release-note\n// comment\n{}\n```',
    body(note())
      .split('\n')
      .map(line => `> ${line}`)
      .join('\n')
  ])
    assert.throws(() => parseReleaseNote(description))
  assert.deepEqual(parseReleaseNote('```js\nexample()\n```\n' + body(note())), note())
  assert.deepEqual(parseReleaseNote(`<!-- ${body(note())} -->\n${body(note())}`), note())
})

test('wrong schemas, shapes, fields and placeholder prose fail', () => {
  for (const value of [
    null,
    [],
    'none',
    1,
    {},
    { ...note(), schemaVersion: 2 },
    { ...note(), schemaVersion: '1' },
    { ...note(), extra: true },
    { ...note(), packages: {} },
    { ...note(), packages: [] },
    { ...note(), packages: null },
    { ...note(), packages: { '@bsv/sdk': 'none' } },
    { ...note(), packages: { '@bsv/sdk': 'PATCH' } },
    { ...note(), packages: { '@bsv/sdk': 1 } },
    { ...note(), packages: { '@bsv/ts-stack': 'patch' } },
    { ...note(), packages: { '@bsv/unknown': 'patch' } },
    { ...note(), packages: 'none', migration: 'Upgrade now' },
    { ...note(), summary: 'none' }
  ])
    assert.ok(validateReleaseNote(value, projects).length > 0, JSON.stringify(value))
  for (const field of ['summary', 'migration']) {
    for (const value of ['', '  ', 'TODO', 'TBD', 'N/A', '...', '<fill this in>', null, [], 3])
      assert.ok(validateReleaseNote({ ...note(), [field]: value }, projects).length > 0)
    const missing = note()
    delete missing[field]
    assert.ok(validateReleaseNote(missing, projects).length > 0)
  }
})

test('PR text stays data and is not echoed in validation errors', () => {
  const text = '$(touch /tmp/do-not-execute) `id`\n::error::untrusted\n${{ secrets.TOKEN }}'
  const value = { ...note(), summary: text, migration: text }
  assert.deepEqual(parseReleaseNote(body(value)), value)
  assert.deepEqual(validateReleaseNote(value, projects), [])
  assert.ok(validateReleaseNote({ ...note(), packages: { [text]: text } }, projects).length)
  assert.ok(
    validateReleaseNote({ ...note(), packages: { [text]: text } }, projects).every(
      error => !error.includes(text)
    )
  )
  assert.throws(
    () => parseReleaseNote('```release-note\n' + text + '\n```'),
    error => !error.message.includes(text)
  )
})

test('reruns fetch the live description instead of using stale event/body environment', async () => {
  const pr = pullRequest()
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/bsv-blockchain/ts-stack/pulls/123')
    assert.equal(options.headers.Authorization, 'Bearer test-only')
    assert.equal(options.redirect, 'error')
    assert.ok(options.signal instanceof AbortSignal)
    return response(pr)
  }
  assert.match(
    await checkReleaseNote({ env: { ...env, PR_BODY: 'stale invalid body' }, args: [], fetchImpl }),
    /passed/
  )
  pr.body = 'Removed after a green run'
  await assert.rejects(
    checkReleaseNote({ env: { ...env, PR_BODY: body(note()) }, args: [], fetchImpl }),
    /exactly one/
  )
})

test('API failures and stale or foreign PR identities fail closed', async () => {
  for (const patch of [
    { number: 124 },
    { state: 'closed' },
    { head: { sha: 'b'.repeat(40) } },
    { base: { ref: 'other', repo: { full_name: env.GITHUB_REPOSITORY } } },
    { base: { ref: 'main', repo: { full_name: 'elsewhere/repo' } } }
  ])
    await assert.rejects(
      currentPullRequestBody(env, async () => response({ ...pullRequest(), ...patch })),
      /identity or head/
    )
  for (const patch of [
    { GITHUB_REPOSITORY: 'elsewhere/repo' },
    { PR_NUMBER: '1; id' },
    { PR_HEAD_SHA: '--help' },
    { GH_TOKEN: '' }
  ])
    await assert.rejects(
      currentPullRequestBody({ ...env, ...patch }, async () => assert.fail('must not fetch')),
      /identity or read token/
    )
  await assert.rejects(
    currentPullRequestBody(env, async () => ({ ok: false })),
    /Unable to read/
  )
  await assert.rejects(
    currentPullRequestBody(env, async () => {
      throw new Error('offline')
    }),
    /offline/
  )
})

test('push, dispatch and merge groups do not require a fictitious PR description', async () => {
  for (const event of ['push', 'workflow_dispatch', 'merge_group'])
    assert.match(
      await checkReleaseNote({
        env: { GITHUB_EVENT_NAME: event },
        args: [],
        fetchImpl: () => assert.fail('must not fetch')
      }),
      /not a pull_request/
    )
  await assert.rejects(checkReleaseNote({ args: ['--unknown'] }), /Usage:/)
})

test('template defaults require an author decision instead of passing unchanged', () => {
  const template = readFileSync(
    new URL('../.github/pull_request_template.md', import.meta.url),
    'utf8'
  )
  assert.ok(validateReleaseNote(parseReleaseNote(template), projects).length > 0)
})
