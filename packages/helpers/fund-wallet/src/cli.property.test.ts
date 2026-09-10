import fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import { DEFAULT_STORAGE_URL, parseCliArguments } from './cli.js'

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

describe('fund-wallet CLI boundary properties', () => {
  test('preserves arbitrary valid network and safe-integer funding options', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('main', 'test'),
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
        (chain, amount) => {
          expect(parseCliArguments(['--chain', chain, '--satoshis', String(amount)])).toEqual({
            kind: 'prompt-key',
            options: {
              chain,
              storageURL: DEFAULT_STORAGE_URL,
              amount
            }
          })
        }
      )
    )
  })

  test('rejects arbitrary credential-bearing and non-HTTPS storage URLs', () => {
    fc.assert(
      fc.property(fc.domain(), fc.constantFrom('http:', 'ftp:'), (domain, insecureProtocol) => {
        const base = ['--chain', 'main', '--storage-url']
        expect(parseCliArguments([...base, `${insecureProtocol}//${domain}`]).kind).toBe('error')
        expect(parseCliArguments([...base, `https://user:secret@${domain}`]).kind).toBe('error')
      })
    )
  })

  test('rejects arbitrary private-key values in process arguments', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 256 }), value => {
        expect(parseCliArguments(['--chain', 'main', '--private-key', value])).toMatchObject({
          kind: 'error',
          message: expect.stringContaining('not accepted in command-line arguments')
        })
        expect(parseCliArguments(['--chain', 'main', `--privateKey=${value}`])).toMatchObject({
          kind: 'error',
          message: expect.stringContaining('not accepted in command-line arguments')
        })
      })
    )
  })

  test('is total for arbitrary untrusted argument vectors', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 256 }), { maxLength: 40 }), arguments_ => {
        expect(() => parseCliArguments(arguments_)).not.toThrow()
      })
    )
  })
})
