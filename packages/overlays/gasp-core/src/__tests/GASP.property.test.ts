import fc from 'fast-check'

import {
  GASP,
  GASPVersionMismatchError,
  LogLevel,
  type GASPOutput,
  type GASPRemote,
  type GASPStorage
} from '../GASP'

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

function harness(
  known: GASPOutput[] = [],
  lastInteraction = 0
): {
  gasp: GASP
  findKnownUTXOs: jest.Mock<Promise<GASPOutput[]>, [number, number?]>
} {
  const findKnownUTXOs = jest.fn(async () => known)
  const storage = {
    findKnownUTXOs
  } as unknown as GASPStorage
  const remote = {} as GASPRemote
  return {
    gasp: new GASP(storage, remote, lastInteraction, '[property] ', false, false, LogLevel.NONE),
    findKnownUTXOs
  }
}

const txid = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map(bytes => Buffer.from(bytes).toString('hex'))
const output = fc.record({
  txid,
  outputIndex: fc.integer({ min: 0, max: 0xffffffff }),
  score: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER })
})

describe('GASP protocol properties', () => {
  test('accepts exactly bounded timestamps and limits at the public request boundary', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
        fc.option(fc.integer({ min: 1, max: 1_000_000 }), { nil: undefined }),
        async (since, limit) => {
          const { gasp, findKnownUTXOs } = harness([], since)
          await expect(gasp.buildInitialRequest(since, limit)).resolves.toEqual({
            version: 1,
            since,
            limit
          })
          await expect(gasp.getInitialResponse({ version: 1, since, limit })).resolves.toEqual({
            since,
            UTXOList: []
          })
          expect(findKnownUTXOs).toHaveBeenCalledWith(since, limit)
        }
      )
    )

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          -1,
          0.5,
          Number.NaN,
          Number.POSITIVE_INFINITY,
          Number.NEGATIVE_INFINITY,
          Number.MAX_SAFE_INTEGER + 1
        ),
        async invalid => {
          expect(() => harness([], invalid)).toThrow('Invalid timestamp format')
          const { gasp } = harness()
          await expect(gasp.buildInitialRequest(invalid)).rejects.toThrow(
            'Invalid timestamp format'
          )
        }
      )
    )

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          -1,
          0,
          0.5,
          Number.NaN,
          Number.POSITIVE_INFINITY,
          Number.MAX_SAFE_INTEGER + 1
        ),
        async invalidLimit => {
          const { gasp } = harness()
          await expect(gasp.buildInitialRequest(0, invalidLimit)).rejects.toThrow(
            'Invalid limit format'
          )
          await expect(
            gasp.getInitialResponse({ version: 1, since: 0, limit: invalidLimit })
          ).rejects.toThrow('Invalid limit format')
        }
      )
    )
  })

  test('computes the exact local-minus-remote outpoint set for arbitrary UTXO collections', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(output, { maxLength: 40 }),
        fc.array(output, { maxLength: 40 }),
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
        async (local, remote, since) => {
          const { gasp } = harness(local)
          const reply = await gasp.getInitialReply({ UTXOList: remote, since })
          const remoteOutpoints = new Set(remote.map(item => `${item.txid}.${item.outputIndex}`))

          expect(reply.UTXOList).toEqual(
            local.filter(item => !remoteOutpoints.has(`${item.txid}.${item.outputIndex}`))
          )
        }
      )
    )

    await fc.assert(
      fc.asyncProperty(
        fc.jsonValue().filter(value => !Array.isArray(value)),
        async invalidUTXOList => {
          const { gasp } = harness()
          await expect(
            gasp.getInitialReply({
              UTXOList: invalidUTXOList as unknown as GASPOutput[],
              since: 0
            })
          ).rejects.toThrow(TypeError)
        }
      )
    )
  })

  test('rejects every foreign protocol version with structured mismatch evidence', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer().filter(version => version !== 1),
        async version => {
          const { gasp } = harness()
          try {
            await gasp.getInitialResponse({ version, since: 0 })
            throw new Error('expected a version mismatch')
          } catch (error) {
            expect(error).toBeInstanceOf(GASPVersionMismatchError)
            expect(error).toMatchObject({
              code: 'ERR_GASP_VERSION_MISMATCH',
              currentVersion: 1,
              foreignVersion: version
            })
          }
        }
      )
    )
  })
})
