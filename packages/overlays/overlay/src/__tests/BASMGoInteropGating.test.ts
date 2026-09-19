import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const INTEROP_SOURCE = join(__dirname, 'BASMGoInterop.test.ts')

/**
 * The Go read/serving interop suite can only run where a go-overlay-services
 * checkout exists, so it is gated. The gate itself has to be asserted from the
 * source text: a behavioural test would agree with a workstation-path fallback
 * on every machine that lacks that path, which is exactly the environment (CI)
 * where such a fallback hides the fact that the suite never runs.
 */
describe('BASM Go interop gating', () => {
  const source = readFileSync(INTEROP_SOURCE, 'utf8')

  it('does not hard-code a developer workstation checkout path', () => {
    expect(source).not.toMatch(/\/(?:Users|home)\/[A-Za-z0-9._-]+\//)
  })

  it('resolves the Go checkout only from BASM_GO_OVERLAY_SERVICES', () => {
    const resolver = /\nfunction resolveGoWorktree\(\)[\s\S]*?\n}\n/.exec(source)?.[0]
    expect(resolver).toBeDefined()
    expect(resolver).toContain('process.env.BASM_GO_OVERLAY_SERVICES')
    expect(resolver?.match(/process\.env\.[A-Za-z_]+/g)).toEqual([
      'process.env.BASM_GO_OVERLAY_SERVICES'
    ])
  })

  it('names the environment variable in the skipped suite title', () => {
    const skipTitle = /goRoot === undefined\s*\?\s*'([^']*)'/.exec(source)?.[1]
    expect(skipTitle).toBeDefined()
    expect(skipTitle).toContain('skipped')
    expect(skipTitle).toContain('BASM_GO_OVERLAY_SERVICES')
  })
})
