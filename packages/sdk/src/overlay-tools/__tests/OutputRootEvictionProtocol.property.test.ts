import fc from 'fast-check'
import {
  parseOutputRootEvictionRequest,
  outputRootEvictionDecisionId,
  validateOutputRootEvictionWindow
} from '../OutputRootEvictionProtocol.js'
import { outputPacketDigest } from '../OutputProtocol.js'
import { rootRequestBody } from './OutputRootEvictionProtocol.fixture.js'

const MIN_PROPERTY_RUNS = 300
const runs = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const seed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const path = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(runs) ? Math.max(MIN_PROPERTY_RUNS, runs) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(seed) ? { seed } : {}),
  ...(path ? { path } : {})
})

test('ordered target sets preserve numeric output order, exact request bytes and root-local decision identity', () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.integer({ min: 0, max: 0xffffffff }), { minLength: 1, maxLength: 12 }),
      fc.bigInt({ min: 0n, max: 18446744073709551614n }),
      fc.uint8Array({ maxLength: 128 }),
      (indexes, revision, proof) => {
        const body = rootRequestBody(),
          target = body.targets[0]
        body.targets = indexes
          .toSorted((a, b) => a - b)
          .map(outputIndex => ({
            ...target,
            outpoint: { ...target.outpoint, outputIndex },
            advertisement: {
              ...target.advertisement,
              outputIndex,
              beef: Buffer.from(proof).toString('base64')
            }
          }))
        const packet = { body, signature: 'AA==' }
        expect(parseOutputRootEvictionRequest(packet)).toEqual(packet)
        expect(() =>
          parseOutputRootEvictionRequest({
            body: { ...body, targets: [body.targets[0], ...body.targets] },
            signature: 'AA=='
          })
        ).toThrow('sorted unique')
        const requestDigest = outputPacketDigest('root-eviction-request', body)
        const input = {
          root: body.recipient,
          requestDigest,
          service: target.service,
          outpoint: body.targets[0].outpoint,
          revision: String(revision)
        }
        const id = outputRootEvictionDecisionId(input)
        expect(
          outputRootEvictionDecisionId({ ...input, revision: String(revision + 1n) })
        ).not.toBe(id)
        body.targets[0].advertisement.beef = Buffer.concat([
          Buffer.from(proof),
          Buffer.from([0])
        ]).toString('base64')
        // Unlike publication semantics, every signed request proof byte is immutable.
        expect(outputPacketDigest('root-eviction-request', body)).not.toBe(requestDigest)
      }
    )
  )
})

test('every finite lifetime rejects the exact expiry while tolerating only the selected future offset', () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 1n, max: 18446744073709465215n }),
      fc.integer({ min: 1, max: 86400 }),
      (issued, lifetime) => {
        const body = {
          ...rootRequestBody(),
          issuedAt: String(issued),
          expiresAt: String(issued + BigInt(lifetime))
        }
        const packet = { body, signature: 'AA==' }
        const clock = {
          now: String(issued),
          maximumLifetimeSeconds: String(lifetime),
          futureClockSeconds: '0'
        }
        expect(validateOutputRootEvictionWindow(packet, clock)).toEqual(packet)
        expect(() =>
          validateOutputRootEvictionWindow(packet, { ...clock, now: body.expiresAt })
        ).toThrow('clock window')
        expect(() =>
          validateOutputRootEvictionWindow(packet, { ...clock, now: String(issued - 1n) })
        ).toThrow('clock window')
        expect(
          validateOutputRootEvictionWindow(packet, {
            ...clock,
            now: String(issued - 1n),
            futureClockSeconds: '1'
          })
        ).toEqual(packet)
      }
    )
  )
})
