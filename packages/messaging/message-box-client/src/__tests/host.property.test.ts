import fc from 'fast-check'

import {
  messageBoxEndpoint,
  normalizeMessageBoxHost,
  normalizeOverlayMessageBoxHost
} from '../host.js'

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

const label = fc.stringMatching(/^[a-z][a-z0-9-]{0,20}[a-z0-9]$|^[a-z]$/)
const routeSegment = fc.stringMatching(/^[a-zA-Z0-9._~-]{1,30}$/)
const publicHost = fc
  .array(label, { minLength: 1, maxLength: 4 })
  .map(labels => `${labels.join('.')}.org`)
  .filter(host => {
    try {
      return new URL(`https://${host}`).hostname === host
    } catch {
      return false
    }
  })

const octet = fc.integer({ min: 0, max: 255 })
const reservedIpv4 = fc
  .oneof(
    fc.tuple(fc.constant(10), octet, octet, octet),
    fc.tuple(fc.constant(127), octet, octet, octet),
    fc.tuple(fc.constant(169), fc.constant(254), octet, octet),
    fc.tuple(fc.constant(172), fc.integer({ min: 16, max: 31 }), octet, octet),
    fc.tuple(fc.constant(192), fc.constant(0), fc.constantFrom(0, 2), octet),
    fc.tuple(fc.constant(192), fc.constant(168), octet, octet),
    fc.tuple(fc.constant(198), fc.constantFrom(18, 19), octet, octet),
    fc.tuple(fc.constant(198), fc.constant(51), fc.constant(100), octet),
    fc.tuple(fc.constant(203), fc.constant(0), fc.constant(113), octet),
    fc.tuple(fc.integer({ min: 224, max: 255 }), octet, octet, octet)
  )
  .map(octets => octets.join('.'))

describe('Message Box host boundary properties', () => {
  test('canonicalizes arbitrary public HTTPS hosts idempotently and builds local endpoints', () => {
    fc.assert(
      fc.property(
        publicHost,
        fc.array(routeSegment, { maxLength: 5 }),
        routeSegment,
        (host, segments, endpoint) => {
          const input = `https://${host}/${segments.join('/')}${segments.length === 0 ? '' : '/'}`
          const normalized = normalizeOverlayMessageBoxHost(input)

          expect(normalized).toBeDefined()
          expect(normalizeOverlayMessageBoxHost(normalized as string)).toBe(normalized)
          expect(new URL(normalized as string).username).toBe('')
          expect(new URL(normalized as string).search).toBe('')
          expect(messageBoxEndpoint(normalized as string, endpoint)).toBe(
            `${normalized as string}/${endpoint}`
          )
        }
      )
    )
  })

  test('rejects arbitrary reserved IPv4 destinations and known reserved IPv6 families', () => {
    fc.assert(
      fc.property(reservedIpv4, host => {
        expect(normalizeOverlayMessageBoxHost(`https://${host}`)).toBeUndefined()
      })
    )

    for (const host of ['[::ffff:127.0.0.1]', '[2001:db8::1]', '[ff02::1]']) {
      expect(normalizeOverlayMessageBoxHost(`https://${host}`)).toBeUndefined()
    }
  })

  test('blocks exact reserved-network edges without widening them into adjacent public space', () => {
    const cases: Array<[host: string, blocked: boolean]> = [
      ['0.0.0.0', true],
      ['1.0.0.0', false],
      ['10.255.255.255', true],
      ['11.0.0.0', false],
      ['100.63.255.255', false],
      ['100.64.0.0', true],
      ['100.127.255.255', true],
      ['100.128.0.0', false],
      ['127.255.255.255', true],
      ['128.0.0.0', false],
      ['169.253.255.255', false],
      ['169.254.0.0', true],
      ['169.255.0.0', false],
      ['172.15.255.255', false],
      ['172.16.0.0', true],
      ['172.31.255.255', true],
      ['172.32.0.0', false],
      ['192.0.0.1', true],
      ['192.0.1.1', false],
      ['192.0.2.1', true],
      ['192.167.255.255', false],
      ['192.168.0.0', true],
      ['192.169.0.0', false],
      ['198.17.255.255', false],
      ['198.18.0.0', true],
      ['198.19.255.255', true],
      ['198.20.0.0', false],
      ['198.51.99.255', false],
      ['198.51.100.0', true],
      ['198.51.101.0', false],
      ['203.0.112.255', false],
      ['203.0.113.0', true],
      ['203.0.114.0', false],
      ['223.255.255.255', false],
      ['224.0.0.0', true],
      ['[fe7f::1]', false],
      ['[fe80::1]', true],
      ['[febf::1]', true],
      ['[fec0::1]', false]
    ]

    for (const [host, blocked] of cases) {
      const normalized = normalizeOverlayMessageBoxHost(`https://${host}`)
      if (blocked) expect(normalized).toBeUndefined()
      else expect(normalized).toBeDefined()
    }
  })

  test('never lets an arbitrary endpoint path replace the selected authority', () => {
    fc.assert(
      fc.property(publicHost, fc.string({ minLength: 1, maxLength: 512 }), (host, path) => {
        fc.pre(path.replace(/^\/+/, '') !== '')
        const base = `https://${host}/api`
        const endpoint = messageBoxEndpoint(base, path)
        expect(new URL(endpoint).origin).toBe(new URL(base).origin)
      })
    )
  })

  test('is total for arbitrary untrusted advertisements while strict normalization either returns or throws', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 4096 }), host => {
        expect(() => normalizeOverlayMessageBoxHost(host)).not.toThrow()
        try {
          const normalized = normalizeMessageBoxHost(host)
          expect(normalizeMessageBoxHost(normalized)).toBe(normalized)
        } catch (error) {
          expect(error).toBeInstanceOf(TypeError)
        }
      })
    )
  })
})
