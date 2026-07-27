import fc from 'fast-check'

import { ConfigError, resolveConfig, validBsvDir } from '../validate'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH

fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

const pathSegment = fc.stringMatching(/^[A-Za-z0-9_-]{1,20}$/)
const relativePath = fc
  .array(pathSegment, { minLength: 1, maxLength: 8 })
  .map(segments => segments.join('/'))

describe('project configuration properties', () => {
  test('preserves arbitrary safe relative output paths in add mode', () => {
    fc.assert(
      fc.property(
        fc.record({
          name: fc.string({ minLength: 1, maxLength: 80 }).filter(name => name.trim().length > 0),
          bsvDir: relativePath,
          client: relativePath,
          server: relativePath
        }),
        ({ name, bsvDir, client, server }) => {
          const result = resolveConfig({
            mode: 'add',
            name,
            bsvDir,
            targets: { client, server }
          })

          expect(result.name).toBe(name.trim())
          expect(result.bsvDir).toBe(bsvDir)
          expect(result.targets).toEqual({ client, server })
        }
      )
    )
  })

  test('rejects absolute and traversal-bearing BSV output paths', () => {
    const unsafePath = fc.oneof(
      relativePath.map(path => `../${path}`),
      relativePath.map(path => `${path}/../escape`),
      relativePath.map(path => `${path}\\..\\escape`),
      relativePath.map(path => `/${path}`),
      relativePath.map(path => `C:\\${path}`)
    )

    fc.assert(
      fc.property(unsafePath, bsvDir => {
        expect(validBsvDir(bsvDir)).toBe(false)
        expect(() => resolveConfig({ mode: 'add', name: 'app', bsvDir })).toThrow(ConfigError)
      })
    )
  })

  test('handles arbitrary structured configuration as a resolved config or a governed error', () => {
    fc.assert(
      fc.property(fc.jsonValue(), input => {
        try {
          const result = resolveConfig(input)
          expect(result.name.length).toBeGreaterThan(0)
          expect(validBsvDir(result.bsvDir)).toBe(true)
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError)
        }
      })
    )
  })
})
