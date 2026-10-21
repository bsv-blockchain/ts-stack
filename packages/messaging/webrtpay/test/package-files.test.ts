/**
 * The README is read from the tarball as often as from the repository, so every file it
 * links to must be one the package publishes (`files` in package.json), or the link is dead
 * for whoever installed it.
 */
import { describe, expect, it } from '@jest/globals'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PUBLISHED: string[] = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).files

/** Targets of the relative links in a Markdown text, without their `#fragment`. */
function relativeLinks(markdown: string): string[] {
  return [...markdown.matchAll(/\]\(([^)\s]+)\)/g)]
    .map(([, target]) => target.split('#')[0])
    .filter(target => target !== '' && !/^[a-z][a-z0-9+.-]*:/i.test(target))
}

/** Whether npm publishes `path` under `files` (an entry names it or a directory above it). */
function published(path: string): boolean {
  return PUBLISHED.some(entry => path === entry || path.startsWith(`${entry}/`))
}

describe('files the README links to', () => {
  it('finds relative link targets, without fragments, urls or in-page anchors', () => {
    expect(
      relativeLinks(
        '[a](docs/protocol.md) [b](#security) [c](https://example.com/x) [d](examples/x.ts#L3)'
      )
    ).toEqual(['docs/protocol.md', 'examples/x.ts'])
    expect(published('docs/protocol.md')).toBe(true)
    expect(published('dist/src/index.js')).toBe(true)
    expect(published('test/relay.test.ts')).toBe(false)
  })

  it('exist and are published with the package', () => {
    const links = relativeLinks(readFileSync(join(ROOT, 'README.md'), 'utf8'))
    expect(links).toEqual(expect.arrayContaining(['docs/protocol.md', 'LICENSE.txt']))
    expect(links.filter(path => !existsSync(join(ROOT, path)))).toEqual([])
    expect(links.filter(path => !published(path))).toEqual([])
  })
})
