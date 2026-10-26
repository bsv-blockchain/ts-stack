import { isMandalaReject } from '../reject.js'
import { InMemoryScreeningProvider, decodeEnvelope, encodeEnvelope } from '../types.js'
import type { MandalaEnvelope, SpecificLinkage } from '../types.js'

const linkage: SpecificLinkage = {
  prover: '02aa',
  verifier: '02bb',
  counterparty: '02cc',
  protocolID: [2, 'mandala token'],
  keyID: 'k1',
  encryptedLinkage: [1, 2, 3],
  encryptedLinkageProof: [0],
  proofType: 0
}

const bytesOf = (text: string): number[] => Array.from(new TextEncoder().encode(text))
const decodeJson = (value: unknown): MandalaEnvelope =>
  decodeEnvelope(bytesOf(JSON.stringify(value)))

// Asserts the exact ERR_SHAPE envelope reason, not just any throw.
const expectEnvelopeReject = (run: () => unknown, detail: string): void => {
  let thrown: unknown
  try {
    run()
  } catch (e) {
    thrown = e
  }
  expect(isMandalaReject(thrown)).toBe(true)
  expect(thrown).toMatchObject({ code: 'ERR_SHAPE', reason: `Mandala payload ${detail}` })
}

describe('InMemoryScreeningProvider', () => {
  it('screens listed identity keys', async () => {
    const p = new InMemoryScreeningProvider(['02aa'])
    expect(await p.isSanctioned('02aa')).toBe(true)
    expect(await p.isSanctioned('02bb')).toBe(false)
  })

  it('canonicalizes key letter case on both sides', async () => {
    expect(await new InMemoryScreeningProvider(['02AB']).isSanctioned('02ab')).toBe(true)
    expect(await new InMemoryScreeningProvider(['02ab']).isSanctioned('02AB')).toBe(true)
  })

  it('screens nobody when built with no keys', async () => {
    expect(await new InMemoryScreeningProvider().isSanctioned('02aa')).toBe(false)
  })
})

describe('encodeEnvelope', () => {
  it('is the UTF-8 bytes of the JSON text', () => {
    const envelope: MandalaEnvelope = {
      inputs: [],
      outputs: [{ index: 0, linkage }],
      admin: [{ index: 1, details: 'a1' }],
      deploySig: '3044'
    }
    expect(encodeEnvelope(envelope)).toEqual(bytesOf(JSON.stringify(envelope)))
  })
})

describe('decodeEnvelope', () => {
  it('round-trips a full v3 envelope', () => {
    const envelope: MandalaEnvelope = {
      inputs: [{ index: 2, linkage }],
      outputs: [{ index: 0, linkage }],
      admin: [{ index: 1, details: 'a1646b696e646672656465656d' }],
      deploySig: '3044022073e9'
    }
    expect(decodeEnvelope(encodeEnvelope(envelope))).toStrictEqual(envelope)
  })

  it.each([
    ['absent', undefined],
    ['empty', []]
  ])('reads %s off-chain values as an empty envelope', (_label, bytes) => {
    const envelope = decodeEnvelope(bytes)
    expect(envelope).toStrictEqual({ inputs: [], outputs: [], admin: [] })
    expect('deploySig' in envelope).toBe(false)
  })

  it('defaults each missing list to empty and leaves deploySig out', () => {
    expect(decodeJson({ outputs: [{ index: 0, linkage }] })).toStrictEqual({
      inputs: [],
      outputs: [{ index: 0, linkage }],
      admin: []
    })
  })

  it('drops unknown top-level keys', () => {
    expect(decodeJson({ inputs: [], future: 1 })).toStrictEqual({
      inputs: [],
      outputs: [],
      admin: []
    })
  })

  it('accepts the same index in different lists', () => {
    const envelope = decodeJson({
      inputs: [{ index: 0, linkage }],
      outputs: [{ index: 0, linkage }],
      admin: [{ index: 0, details: '00' }]
    })
    expect(envelope.inputs[0].index).toBe(0)
    expect(envelope.outputs[0].index).toBe(0)
    expect(envelope.admin[0].index).toBe(0)
  })

  it('accepts the largest safe integer as an index', () => {
    const index = Number.MAX_SAFE_INTEGER
    expect(decodeJson({ outputs: [{ index, linkage }] }).outputs[0].index).toBe(index)
  })

  it.each([null, false, 1, 'text', [], [{ index: 0 }]])('rejects non-object payload %p', value => {
    expectEnvelopeReject(() => decodeJson(value), 'must be an object')
  })

  it.each([
    ['not JSON', bytesOf('{"inputs":')],
    ['invalid UTF-8', [0x7b, 0xff, 0x7d]],
    // Inside a string a lenient decoder would substitute U+FFFD and parse; strict decoding refuses.
    ['invalid UTF-8 inside a string', [...bytesOf('{"note":"'), 0xff, ...bytesOf('"}')]],
    ['an overlong UTF-8 sequence', [...bytesOf('{"note":"'), 0xc0, 0xaf, ...bytesOf('"}')]],
    ['a UTF-8 encoded surrogate', [...bytesOf('{"note":"'), 0xed, 0xa0, 0x80, ...bytesOf('"}')]],
    ['a leading byte-order mark', [0xef, 0xbb, 0xbf, ...bytesOf('{}')]]
  ])('rejects %s', (_label, bytes) => {
    expectEnvelopeReject(() => decodeEnvelope(bytes), 'must be UTF-8 JSON')
  })

  describe.each(['inputs', 'outputs', 'admin'])('%s', label => {
    const entry = (index: unknown): Record<string, unknown> =>
      label === 'admin' ? { index, details: '00' } : { index, linkage }

    it.each([null, {}, 1, 'x', true])('must be an array when present (%p)', value => {
      expectEnvelopeReject(() => decodeJson({ [label]: value }), `${label} must be an array`)
    })

    it.each([
      ['a null entry', [null]],
      ['a non-object entry', [7]],
      ['a missing index', [{}]],
      ['a negative index', [entry(-1)]],
      ['a fractional index', [entry(0.5)]],
      ['a string index', [entry('0')]],
      ['an unsafe index', [entry(Number.MAX_SAFE_INTEGER + 1)]],
      ['a duplicate index', [entry(3), entry(3)]]
    ])('rejects %s', (_case, entries) => {
      expectEnvelopeReject(
        () => decodeJson({ [label]: entries }),
        `${label} must contain unique non-negative integer indices`
      )
    })
  })

  it.each([
    ['uppercase hex', 'A1'],
    ['odd-length hex', 'a1f'],
    ['empty text', ''],
    ['non-hex text', 'zz'],
    ['a hex prefix', '0xa1'],
    ['a trailing newline', 'a1\n'],
    ['a number', 161],
    ['null', null],
    ['a missing value', undefined]
  ])('rejects admin details given as %s', (_label, details) => {
    expectEnvelopeReject(
      () => decodeJson({ admin: [{ index: 1, details }] }),
      'admin details must be lowercase hex'
    )
  })

  it.each([
    ['uppercase hex', '3044AB'],
    ['odd-length hex', '304'],
    ['empty text', ''],
    ['a number', 3044],
    ['null', null]
  ])('rejects deploySig given as %s', (_label, deploySig) => {
    expectEnvelopeReject(() => decodeJson({ deploySig }), 'deploySig must be lowercase hex')
  })

  it('checks indices before admin details', () => {
    expectEnvelopeReject(
      () => decodeJson({ admin: [{ index: -1, details: 'XX' }] }),
      'admin must contain unique non-negative integer indices'
    )
  })

  it('checks inputs, then outputs, then admin', () => {
    expectEnvelopeReject(
      () => decodeJson({ inputs: 1, outputs: 1, admin: 1 }),
      'inputs must be an array'
    )
    expectEnvelopeReject(() => decodeJson({ outputs: 1, admin: 1 }), 'outputs must be an array')
  })
})
