import { mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonFileStore } from '../json-file-store'

describe('JsonFileStore security boundaries', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'simple-json-store-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('atomically stores private regular files and reads their exact JSON', () => {
    const path = join(directory, 'state.json')
    const store = new JsonFileStore<{ secret: string }>(path)

    store.save({ secret: 'value' })

    expect(store.load()).toEqual({ secret: 'value' })
    expect(statSync(path).mode & 0o077).toBe(0)
    expect(readFileSync(path, 'utf8')).toContain('"secret": "value"')
  })

  it('fails closed without replacing corrupt persisted identity state', () => {
    const path = join(directory, 'state.json')
    writeFileSync(path, '{not-json', { mode: 0o600 })
    const store = new JsonFileStore(path)

    expect(() => store.load()).toThrow('could not be loaded safely')
    expect(readFileSync(path, 'utf8')).toBe('{not-json')
  })

  it('refuses to follow a persisted-state symlink', () => {
    const target = join(directory, 'target.json')
    const path = join(directory, 'state.json')
    writeFileSync(target, '{"secret":"target"}', { mode: 0o600 })
    symlinkSync(target, path)

    expect(() => new JsonFileStore(path).load()).toThrow('could not be loaded safely')
  })
})
