import fc from 'fast-check'

import { extractSseFrames, parseReorgEvent } from '../ReorgStream.js'

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

const hashHex = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map(bytes => Buffer.from(bytes).toString('hex'))

describe('reorg stream parser properties', () => {
  test('normalizes arbitrary valid reorg events and honors the common ancestor', () => {
    fc.assert(
      fc.property(
        fc.array(hashHex, { maxLength: 20 }),
        fc.record({
          ancestorHeight: fc.integer({ min: 0, max: 10_000_000 }),
          tipDelta: fc.integer({ min: 0, max: 10_000_000 })
        }),
        (hashes, { ancestorHeight, tipDelta }) => {
          const newTipHeight = ancestorHeight + tipDelta
          const result = parseReorgEvent(
            JSON.stringify({
              orphanedHashes: hashes.map(hash => hash.toUpperCase()),
              commonAncestor: { height: ancestorHeight },
              newTip: { height: newTipHeight }
            })
          )

          expect(result).toEqual({
            orphanedBlockHashes: hashes,
            rebuildFromHeight: ancestorHeight + 1,
            newTipHeight
          })
        }
      )
    )
  })

  test('uses bounded depth fallback and rejects non-finite or fractional heights', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        (newTipHeight, depth) => {
          const result = parseReorgEvent(
            JSON.stringify({
              orphanedHashes: [],
              commonAncestor: null,
              newTip: { height: newTipHeight },
              depth
            })
          )
          expect(result?.rebuildFromHeight).toBe(Math.max(0, newTipHeight - depth + 1))
        }
      )
    )

    fc.assert(
      fc.property(
        fc.oneof(
          fc.double({ noNaN: true, noDefaultInfinity: true }).filter(Number.isFinite),
          fc.constant(Infinity)
        ),
        invalidHeight => {
          fc.pre(!Number.isSafeInteger(invalidHeight) || invalidHeight < 0)
          expect(
            parseReorgEvent(
              JSON.stringify({
                commonAncestor: { height: 0 },
                newTip: { height: invalidHeight }
              })
            )
          ).toBeNull()
        }
      )
    )

    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 1, max: 10_000_000 }),
        (newTipHeight, delta) => {
          expect(
            parseReorgEvent(
              JSON.stringify({
                commonAncestor: { height: newTipHeight + delta },
                newTip: { height: newTipHeight }
              })
            )
          ).toBeNull()
        }
      )
    )
  })

  test('extracts arbitrary complete SSE data frames and preserves the exact partial suffix', () => {
    const line = fc.string({ maxLength: 200 }).filter(value => !value.includes('\n'))
    fc.assert(
      fc.property(fc.array(line, { maxLength: 30 }), line, (payloads, partial) => {
        const buffer = payloads.map(payload => `data: ${payload}\n\n`).join('') + `data: ${partial}`
        expect(extractSseFrames(buffer)).toEqual({
          events: payloads,
          rest: `data: ${partial}`
        })
      })
    )
  })

  test('is total for arbitrary untrusted text frames', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 4096 }), frame => {
        expect(() => parseReorgEvent(frame)).not.toThrow()
        expect(() => extractSseFrames(frame)).not.toThrow()
      })
    )
  })
})
