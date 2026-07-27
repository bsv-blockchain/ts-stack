import fc from 'fast-check'

import { parsePaymail } from '../paymailAddress.js'

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

const alias = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789._%+-'), {
    minLength: 1,
    maxLength: 64
  })
  .map(characters => characters.join(''))
const domainLabel = fc.stringMatching(/^[a-z][a-z0-9-]{0,20}[a-z0-9]$|^[a-z]$/)
const domain = fc.array(domainLabel, { minLength: 2, maxLength: 6 }).map(labels => labels.join('.'))

describe('paymail address parser properties', () => {
  test('accepts and exactly separates arbitrary valid aliases and DNS names', () => {
    fc.assert(
      fc.property(alias, domain, (name, host) => {
        expect(parsePaymail(`${name}@${host}`)).toEqual({ name, domain: host })
      })
    )
  })

  test('rejects ambiguous separators and invalid DNS label boundaries', () => {
    fc.assert(
      fc.property(alias, domain, (name, host) => {
        expect(parsePaymail(`${name}@@${host}`)).toBeUndefined()
        expect(parsePaymail(`${name}@-${host}`)).toBeUndefined()
        expect(parsePaymail(`${name}@${host}-`)).toBeUndefined()
      })
    )
  })

  test('enforces exact alias, host, and label boundaries', () => {
    const aliasAtLimit = 'a'.repeat(64)
    const domainAtLimit = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.')

    expect(parsePaymail(`${aliasAtLimit}@${domainAtLimit}`)).toEqual({
      name: aliasAtLimit,
      domain: domainAtLimit
    })
    for (const invalid of [
      'example.com',
      '@example.com',
      'name@',
      'name@@example.com',
      `${'a'.repeat(65)}@example.com`,
      `name@${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}`,
      'name@example..com',
      'name@exa_mple.com',
      '!name@example.com',
      'name!@example.com'
    ]) {
      expect(parsePaymail(invalid)).toBeUndefined()
    }
  })

  test('is total for arbitrary untrusted strings', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 1024 }), value => {
        expect(() => parsePaymail(value)).not.toThrow()
      })
    )
  })
})
