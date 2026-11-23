import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'

import {
  ROOT,
  applyRelease,
  checkDiff,
  createChange,
  formatChange,
  insertChangelogSection,
  loadChanges,
  nextVersion,
  parseChange,
  planRelease,
  releaseNoteFor,
  setPageVersion
} from './release-changes.mjs'
import { validateReleaseNote } from './pr-release-note.mjs'

const PROJECTS_PATH = 'governance/repository-health/projects.json'

const MIGRATION = 'No consumer migration is required for this change.'
const roots = []

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true })
})

const write = (root, path, content) => {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(
    join(root, path),
    typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`
  )
}
const readJson = (root, path) => JSON.parse(readFileSync(join(root, path), 'utf8'))

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'release-changes-'))
  roots.push(root)
  write(root, 'governance/repository-health/projects.json', {
    projects: [
      { name: '@bsv/a', path: 'packages/a', release: 'npm-oidc' },
      { name: '@bsv/b', path: 'packages/b', release: 'npm-oidc' },
      { name: '@bsv/b-client', path: 'packages/b/client', release: 'npm-oidc' },
      { name: '@bsv/new', path: 'packages/new', release: 'npm-oidc' },
      { name: 'private-app', path: 'apps/x', release: 'none' }
    ]
  })
  write(root, 'packages/a/package.json', { name: '@bsv/a', version: '1.2.3' })
  write(root, 'packages/b/package.json', { name: '@bsv/b', version: '2.0.1' })
  write(root, 'packages/b/client/package.json', { name: '@bsv/b-client', version: '2.0.1' })
  write(root, 'packages/new/package.json', { name: '@bsv/new', version: '0.1.0' })
  write(
    root,
    'packages/a/CHANGELOG.md',
    '# Changelog\n\n## [Unreleased]\n\n- pending\n\n## [1.2.3] - 2026-01-01\n\n- old\n'
  )
  write(
    root,
    'packages/b/CHANGELOG.md',
    '# b history\n\n## b 2.0.1 (source candidate)\n\n- earlier candidate\n\n## b 2.0.0\n\n- old\n'
  )
  const entry = (name, publishedVersion, releaseType) => ({
    name,
    publishedVersion,
    releaseType,
    summary: `Existing summary text for ${name}.`,
    migration: `Existing migration text for ${name}.`
  })
  write(root, 'governance/package-release-notes.json', {
    schemaVersion: 1,
    lastReviewed: '2026-01-01',
    owner: 'maintainers',
    entries: [
      entry('@bsv/a', '1.2.3', 'none'),
      entry('@bsv/b', '2.0.0', 'patch'),
      entry('@bsv/b-client', '2.0.0', 'patch'),
      entry('@bsv/new', null, 'initial')
    ]
  })
  write(root, 'governance/repository-health/baselines.json', {
    schemaVersion: 1,
    publicPackageVersions: {
      '@bsv/a': '1.2.3',
      '@bsv/b': '2.0.1',
      '@bsv/b-client': '2.0.1',
      '@bsv/new': '0.1.0'
    }
  })
  return root
}

const change = (root, name, release, summary = 'A consumer-visible change that matters.') =>
  write(root, `changes/${name}`, formatChange({ release, summary, migration: MIGRATION }))

describe('nextVersion', () => {
  test('bumps a published package from its published version', () => {
    assert.equal(
      nextVersion({ publishedVersion: '1.2.3', currentVersion: '1.2.3', impact: 'patch' }),
      '1.2.4'
    )
    assert.equal(
      nextVersion({ publishedVersion: '1.2.3', currentVersion: '1.2.3', impact: 'minor' }),
      '1.3.0'
    )
    assert.equal(
      nextVersion({ publishedVersion: '1.2.3', currentVersion: '1.2.3', impact: 'major' }),
      '2.0.0'
    )
  })

  test('does not bump an unpublished candidate twice', () => {
    assert.equal(
      nextVersion({ publishedVersion: '2.0.0', currentVersion: '2.0.1', impact: 'patch' }),
      '2.0.1'
    )
    assert.equal(
      nextVersion({ publishedVersion: '2.0.0', currentVersion: '2.1.0', impact: 'patch' }),
      '2.1.0'
    )
    assert.equal(
      nextVersion({ publishedVersion: '2.0.0', currentVersion: '2.0.1', impact: 'minor' }),
      '2.1.0'
    )
  })

  test('keeps the source version of a package that was never published', () => {
    assert.equal(
      nextVersion({ publishedVersion: null, currentVersion: '0.1.0', impact: 'minor' }),
      '0.1.0'
    )
  })
})

describe('parseChange', () => {
  test('round-trips a formatted change', () => {
    const text = formatChange({
      release: { '@bsv/a': 'minor' },
      summary: 'Adds a useful thing.',
      migration: MIGRATION
    })
    const parsed = parseChange(text)
    assert.deepEqual(parsed.errors, [])
    assert.deepEqual(parsed.release, { '@bsv/a': 'minor' })
    assert.equal(parsed.summary, 'Adds a useful thing.')
    assert.equal(parsed.migration, MIGRATION)
  })

  test('accepts unquoted names', () => {
    const parsed = parseChange(
      `---\nrelease:\n  @bsv/a: patch\n---\nFixes a real defect here.\n\n## Migration\n\n${MIGRATION}\n`
    )
    assert.deepEqual(parsed.errors, [])
    assert.deepEqual(parsed.release, { '@bsv/a': 'patch' })
  })

  test('rejects missing pieces', () => {
    assert.match(parseChange('no frontmatter').errors[0], /frontmatter/)
    const errors = parseChange('---\nrelease:\n  "@bsv/a": huge\n---\nshort\n').errors
    assert.ok(errors.some(error => /impact huge/.test(error)))
    assert.ok(errors.some(error => /Migration/.test(error)))
    assert.ok(errors.some(error => /summary/.test(error)))
  })
})

test('setPageVersion keeps the quote style and the body', () => {
  assert.equal(
    setPageVersion('---\nversion: "1.0.0"\n---\nversion: 1', '1.1.0'),
    '---\nversion: "1.1.0"\n---\nversion: 1'
  )
  assert.equal(setPageVersion('---\nversion: 1.0.0\n---\n', '2.0.0'), '---\nversion: 2.0.0\n---\n')
  assert.equal(setPageVersion('no frontmatter', '2.0.0'), 'no frontmatter')
})

describe('insertChangelogSection', () => {
  const changes = [{ summary: 'New feature text.', migration: MIGRATION }]

  test('adds a release after the Unreleased section', () => {
    const text = '# C\n\n## [Unreleased]\n\n- pending\n\n## [1.2.3] - 2026-01-01\n\n- old\n'
    const result = insertChangelogSection(text, { version: '1.3.0', date: '2026-11-04', changes })
    assert.match(
      result,
      /## \[Unreleased\]\n\n- pending\n\n## \[1\.3\.0\] - 2026-11-04\n\n- New feature text\.\n\n {2}Migration: No consumer/
    )
    assert.ok(result.indexOf('1.3.0') < result.indexOf('[1.2.3]'))
  })

  test('follows a custom heading style', () => {
    const text = '# h\n\n## b 2.0.0\n\n- old\n'
    const result = insertChangelogSection(text, { version: '2.1.0', date: '2026-11-04', changes })
    assert.match(result, /## b 2\.1\.0\n\n- New feature text\./)
  })

  test('extends the section of an unpublished candidate', () => {
    const text = '# h\n\n## b 2.0.1 (source candidate)\n\n- earlier\n\n## b 2.0.0\n\n- old\n'
    const result = insertChangelogSection(text, { version: '2.0.1', date: '2026-11-04', changes })
    assert.equal(result.match(/2\.0\.1/g).length, 1)
    assert.match(result, /- earlier\n\n- New feature text\.\n\n {2}Migration: .*\n\n## b 2\.0\.0/)
  })
})

describe('release plan', () => {
  test('rejects unknown packages and bad file names', () => {
    const root = fixture()
    change(root, '20261104-ok.md', { '@bsv/unknown': 'patch' })
    change(root, 'Bad Name.md', { '@bsv/a': 'patch' })
    const { errors } = loadChanges(root)
    assert.ok(errors.some(error => /@bsv\/unknown/.test(error)))
    assert.ok(errors.some(error => /Bad Name\.md must be named/.test(error)))
  })

  test('takes the strongest impact and moves nested packages in lockstep', () => {
    const root = fixture()
    change(root, '20261104-one.md', { '@bsv/a': 'patch' })
    change(root, '20261104-two.md', { '@bsv/a': 'minor', '@bsv/b-client': 'patch' })
    const { plan, errors } = planRelease(root)
    assert.deepEqual(errors, [])
    const versions = Object.fromEntries(plan.map(item => [item.name, item.version]))
    assert.deepEqual(versions, { '@bsv/a': '1.3.0', '@bsv/b': '2.0.1', '@bsv/b-client': '2.0.1' })
  })

  test('builds a release-note block that the PR release-note contract accepts', () => {
    const root = fixture()
    change(root, '20261104-one.md', { '@bsv/a': 'minor' }, 'Adds the first feature to a.')
    change(root, '20261104-two.md', { '@bsv/b-client': 'patch' }, 'Fixes a defect in b.')
    const { plan, changes, errors } = planRelease(root)
    assert.deepEqual(errors, [])
    const note = releaseNoteFor(plan, changes)
    assert.deepEqual(note.packages, {
      '@bsv/a': 'minor',
      '@bsv/b': 'patch',
      '@bsv/b-client': 'patch'
    })
    assert.match(note.summary, /first feature to a\..*defect in b\./)
    assert.deepEqual(validateReleaseNote(note, readJson(root, PROJECTS_PATH).projects), [])
    const empty = releaseNoteFor([], [])
    assert.equal(empty.packages, 'none')
    assert.deepEqual(validateReleaseNote(empty, readJson(root, PROJECTS_PATH).projects), [])
  })

  test('applies every pending change in one pass', () => {
    const root = fixture()
    change(root, '20261104-one.md', { '@bsv/a': 'minor' }, 'Adds the first feature to a.')
    change(
      root,
      '20261104-two.md',
      { '@bsv/b': 'minor', '@bsv/new': 'patch' },
      'Adds a feature to b and new.'
    )
    const result = applyRelease(root, { date: '2026-11-04' })
    assert.deepEqual(result.errors, [])
    assert.equal(readJson(root, 'packages/a/package.json').version, '1.3.0')
    assert.equal(readJson(root, 'packages/b/package.json').version, '2.1.0')
    assert.equal(readJson(root, 'packages/b/client/package.json').version, '2.1.0')
    assert.equal(readJson(root, 'packages/new/package.json').version, '0.1.0')

    const notes = new Map(
      readJson(root, 'governance/package-release-notes.json').entries.map(e => [e.name, e])
    )
    assert.equal(notes.get('@bsv/a').releaseType, 'minor')
    assert.equal(notes.get('@bsv/a').summary, 'Adds the first feature to a.')
    assert.equal(notes.get('@bsv/b').releaseType, 'minor')
    assert.equal(
      notes.get('@bsv/b').summary,
      'Existing summary text for @bsv/b. Adds a feature to b and new.'
    )
    assert.equal(notes.get('@bsv/b-client').releaseType, 'minor')
    assert.equal(notes.get('@bsv/new').releaseType, 'initial')
    assert.equal(readJson(root, 'governance/package-release-notes.json').lastReviewed, '2026-11-04')
    assert.equal(
      readJson(root, 'governance/repository-health/baselines.json').publicPackageVersions[
        '@bsv/b-client'
      ],
      '2.1.0'
    )

    assert.match(
      readFileSync(join(root, 'packages/a/CHANGELOG.md'), 'utf8'),
      /## \[1\.3\.0\] - 2026-11-04/
    )
    assert.match(readFileSync(join(root, 'packages/b/CHANGELOG.md'), 'utf8'), /## b 2\.1\.0\n/)
    assert.deepEqual(readdirSync(join(root, 'changes')), [])
  })

  test('createChange writes a unique, valid file', () => {
    const root = fixture()
    const options = {
      release: { '@bsv/a': 'patch' },
      summary: 'Fixes a decoding defect in a.',
      migration: MIGRATION
    }
    const first = createChange(root, options)
    const second = createChange(root, options)
    assert.deepEqual(first.errors, [])
    assert.notEqual(first.file, second.file)
    assert.deepEqual(loadChanges(root).errors, [])
    assert.ok(createChange(root, { ...options, release: { nope: 'patch' } }).errors.length > 0)
  })
})

describe('checkDiff', () => {
  const gitIn = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  const repo = () => {
    const root = fixture()
    gitIn(root, 'init', '-q', '-b', 'main')
    gitIn(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A')
    gitIn(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base')
    return root
  }
  const commit = root => {
    gitIn(root, 'add', '-A')
    gitIn(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'change')
  }

  test('rejects a direct version bump', () => {
    const root = repo()
    write(root, 'packages/a/package.json', { name: '@bsv/a', version: '1.2.4' })
    commit(root)
    const { errors } = checkDiff(root, 'HEAD~1', 'HEAD')
    assert.equal(errors.length, 1)
    assert.match(errors[0], /packages\/a\/package\.json changes version 1\.2\.3 -> 1\.2\.4/)
  })

  test('accepts a change file and the version pull request that applies it', () => {
    const root = repo()
    change(root, '20261104-one.md', { '@bsv/a': 'patch' })
    commit(root)
    assert.deepEqual(checkDiff(root, 'HEAD~1', 'HEAD').errors, [])
    applyRelease(root, { date: '2026-11-04' })
    commit(root)
    const result = checkDiff(root, 'HEAD~1', 'HEAD')
    assert.deepEqual(result.errors, [])
    assert.equal(result.appliesChanges, true)
  })
})

test('the repository change files are valid', () => {
  assert.deepEqual(planRelease(ROOT).errors, [])
})
