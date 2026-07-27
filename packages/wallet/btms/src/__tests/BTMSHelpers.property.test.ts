import fc from 'fast-check'

import { parseIncomingMessage, parseMetadata, stripLabelPrefix } from '../BTMSHelpers.js'
import { BTMS_LABEL_PREFIX } from '../constants.js'
import { parseCustomInstructions } from '../utils.js'

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

const nonEmptyString = fc.string({ minLength: 1, maxLength: 100 })

describe('BTMS untrusted data properties', () => {
  test('round-trips arbitrary JSON metadata and message bodies without losing caller metadata', () => {
    fc.assert(
      fc.property(
        fc.jsonValue(),
        fc.string({ maxLength: 100 }),
        fc.string({ maxLength: 100 }),
        (value, messageId, sender) => {
          const body = JSON.stringify(value)
          const canonical = JSON.parse(body)
          expect(parseMetadata(body)).toEqual(canonical)

          const parsed = parseIncomingMessage({ body, messageId, sender }) as Record<
            string,
            unknown
          > | null
          if (canonical !== null && typeof canonical === 'object' && !Array.isArray(canonical)) {
            expect(parsed).toMatchObject({ ...canonical, messageId, sender })
          }
        }
      )
    )
    expect(parseMetadata('{not-json')).toBeUndefined()
    expect(parseIncomingMessage({ body: '{not-json' })).toBeNull()
  })

  test('round-trips valid derivation instructions and rejects non-string derivation material', () => {
    fc.assert(
      fc.property(
        nonEmptyString,
        nonEmptyString,
        fc.option(nonEmptyString, { nil: undefined }),
        (derivationPrefix, derivationSuffix, senderIdentityKey) => {
          const encoded = JSON.stringify({
            derivationPrefix,
            derivationSuffix,
            ...(senderIdentityKey === undefined ? {} : { senderIdentityKey })
          })
          expect(parseCustomInstructions(encoded, 'txid', 0)).toEqual({
            keyID: `${derivationPrefix} ${derivationSuffix}`,
            ...(senderIdentityKey === undefined ? {} : { senderIdentityKey })
          })
        }
      )
    )

    fc.assert(
      fc.property(
        fc.oneof(fc.integer(), fc.boolean(), fc.array(fc.string()), fc.object()),
        invalid => {
          const encoded = JSON.stringify({
            derivationPrefix: invalid,
            derivationSuffix: 'suffix'
          })
          expect(() => parseCustomInstructions(encoded, 'txid', 0)).toThrow(
            'Missing derivation info'
          )
        }
      )
    )
    expect(() => parseCustomInstructions(undefined, 'txid', 7)).toThrow('txid.7')
  })

  test('strips exactly one governed label prefix and is total for arbitrary message text', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 200 }), { maxLength: 100 }), labels => {
        const prefixed = labels.map(label => `${BTMS_LABEL_PREFIX}${label}`)
        expect(stripLabelPrefix(prefixed)).toEqual(labels)
      })
    )

    fc.assert(
      fc.property(fc.string({ maxLength: 4096 }), body => {
        expect(() => parseIncomingMessage({ body })).not.toThrow()
      })
    )
  })
})
