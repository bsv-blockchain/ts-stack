import { PrivateKey } from '@bsv/sdk'
import {
  BsvDid,
  SdJwtVcVerifier,
  applyDisclosures,
  base64UrlEncodeJson,
  disclosureDigest,
  publicKeyToJwk,
  selectDisclosures,
  serializeSdJwt,
  signJwt
} from '../src/index.js'
import {
  collectDigestPaths,
  createDisclosure,
  makeSdPayload,
  parseDisclosure
} from '../src/sd-jwt/disclosures.js'
import {
  MAX_DISCLOSURES,
  MAX_IDENTIFIER_BYTES,
  MAX_JSON_DEPTH,
  MAX_JSON_NODES,
  MAX_JSON_STRING_BYTES,
  getOwnDataProperties,
  parseStrictJson,
  snapshotBytes,
  snapshotJsonObject,
  snapshotJsonValue
} from '../src/validation.js'

const issuerPrivateKey = new PrivateKey(21)
const holderPrivateKey = new PrivateKey(22)
const issuerDid = BsvDid.fromPublicKey(issuerPrivateKey.toPublicKey())
const credentialType = 'urn:example:defensive-boundary'

function credential(overrides: Record<string, unknown> = {}, typ = 'dc+sd-jwt'): string {
  const jwt = signJwt(
    { typ },
    {
      iss: issuerDid,
      iat: 1_000,
      vct: credentialType,
      cnf: { jwk: publicKeyToJwk(holderPrivateKey.toPublicKey()) },
      ...overrides
    },
    issuerPrivateKey
  )
  return serializeSdJwt(jwt, [])
}

describe('defensive JSON ownership boundaries', () => {
  test('rejects nested accessors without invoking them, cycles, symbols, and sparse arrays', () => {
    let invoked = 0
    const accessor = {}
    Object.defineProperty(accessor, 'secret', {
      enumerable: true,
      get() {
        invoked += 1
        return 'stolen'
      }
    })
    expect(() => snapshotJsonObject({ nested: accessor }, 'input')).toThrow('own data property')
    expect(invoked).toBe(0)

    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(() => snapshotJsonObject({ nested: cycle }, 'input')).toThrow('cycle')

    const symbolObject = { value: 1 }
    Object.defineProperty(symbolObject, Symbol('hidden'), { enumerable: true, value: 2 })
    expect(() => snapshotJsonObject({ nested: symbolObject }, 'input')).toThrow('symbol properties')

    const symbolArray = [1]
    Object.defineProperty(symbolArray, Symbol('hidden'), { enumerable: true, value: 2 })
    expect(() => snapshotJsonValue(symbolArray, 'input')).toThrow('symbol properties')

    const sparse: unknown[] = []
    sparse.length = 2
    sparse[1] = 'present'
    expect(() => snapshotJsonValue(sparse, 'input')).toThrow('own data property')

    const extended = [1] as unknown[] & { extra?: number }
    extended.extra = 2
    expect(() => snapshotJsonValue(extended, 'input')).toThrow('unexpected property')
    expect(() => snapshotJsonValue(new Date(), 'input')).toThrow('plain JSON objects')
  })

  test('rejects non-JSON values, non-finite numbers, and malformed Unicode at any depth', () => {
    for (const value of [undefined, 1n, Symbol('x'), () => undefined, NaN, Infinity]) {
      expect(() => snapshotJsonValue({ nested: { value } }, 'input')).toThrow()
    }
    expect(() => snapshotJsonValue({ nested: '\ud800' }, 'input')).toThrow('unpaired Unicode')
    expect(() => snapshotJsonValue({ nested: '\udc00' }, 'input')).toThrow('unpaired Unicode')
    expect(() => snapshotJsonValue({ ['bad\ud800']: true }, 'input')).toThrow('unpaired Unicode')
    expect(snapshotJsonValue({ nested: 'Zürich 😀' }, 'input')).toEqual({ nested: 'Zürich 😀' })
  })

  test('enforces depth, node, and UTF-8 string-data budgets', () => {
    let tooDeep: Record<string, unknown> = { value: true }
    for (let index = 0; index <= MAX_JSON_DEPTH; index++) tooDeep = { nested: tooDeep }
    expect(() => snapshotJsonObject(tooDeep, 'input')).toThrow('depth limit')

    const tooManyNodes = Array.from({ length: MAX_JSON_NODES }, () => null)
    expect(() => snapshotJsonValue(tooManyNodes, 'input')).toThrow('node limit')
    expect(() => snapshotJsonValue('x'.repeat(MAX_JSON_STRING_BYTES + 1), 'input')).toThrow(
      'string-data limit'
    )
    expect(() =>
      snapshotJsonObject({ ['x'.repeat(MAX_JSON_STRING_BYTES + 1)]: true }, 'input')
    ).toThrow('string-data limit')
  })

  test('strict JSON rejects duplicate keys, invalid escapes, invalid numbers, and lone surrogates', () => {
    for (const text of [
      '{"key":1,"key":2}',
      '{"key":"\\uZZZZ"}',
      '"unterminated',
      '01',
      '1.',
      '1e',
      'true false',
      '{"key":"\\ud800"}',
      '{"\\udc00":true}'
    ]) {
      expect(() => parseStrictJson(text, 'input')).toThrow()
    }
    expect(parseStrictJson('{"empty":{},"array":[],"number":-1.5e+2}', 'input')).toEqual({
      empty: {},
      array: [],
      number: -150
    })
    expect(() =>
      parseStrictJson(`[${Array(MAX_JSON_NODES).fill('null').join(',')}]`, 'input')
    ).toThrow('node limit')
  })

  test('snapshots byte arrays and option records without sparse, accessor, or symbol data', () => {
    const source = new Uint8Array([1, 2, 3])
    expect(snapshotBytes(source, 'bytes', 3, [3])).toEqual([1, 2, 3])
    source[0] = 9
    expect(snapshotBytes(source, 'bytes', 3, [3])).toEqual([9, 2, 3])
    expect(() => snapshotBytes(source, 'bytes', 2)).toThrow('byte limit')
    expect(() => snapshotBytes('123' as never, 'bytes', 3)).toThrow('byte array')
    expect(() => snapshotBytes([1], 'bytes', 3, [2])).toThrow('invalid length')
    expect(() => snapshotBytes([256], 'bytes', 3)).toThrow('must be a byte')
    const sparse: number[] = []
    sparse.length = 2
    sparse[0] = 1
    expect(() => snapshotBytes(sparse, 'bytes', 3)).toThrow('own data byte')

    const symbolOptions = { allowed: true }
    Object.defineProperty(symbolOptions, Symbol('hidden'), { value: true })
    expect(() => getOwnDataProperties(symbolOptions, 'options', new Set(['allowed']))).toThrow(
      'symbol properties'
    )
    expect(() => getOwnDataProperties({ unexpected: true }, 'options', new Set())).toThrow(
      'unknown property'
    )
  })
})

describe('hostile recursive Disclosure graphs', () => {
  test('applies a complete nested ancestor chain with owned Unicode claim values', () => {
    const locality = base64UrlEncodeJson(['locality-salt', 'locality', 'Zürich 😀'])
    const localityDigest = disclosureDigest(locality)
    const address = base64UrlEncodeJson([
      'address-salt',
      'address',
      { country: 'CH', _sd: [localityDigest] }
    ])
    const addressDigest = disclosureDigest(address)
    const payload = { _sd_alg: 'sha-256', _sd: [addressDigest] }

    const applied = applyDisclosures(payload, [address, locality])
    expect(applied.payload).toEqual({ address: { country: 'CH', locality: 'Zürich 😀' } })
    expect(applied.disclosedClaims).toEqual({
      address: { country: 'CH', locality: 'Zürich 😀' }
    })
    expect(collectDigestPaths(payload).get(addressDigest)).toEqual([])
    expect(selectDisclosures(payload, [address, locality], ['address.locality'])).toEqual([
      address,
      locality
    ])
    expect(parseDisclosure(locality)).toEqual({
      salt: 'locality-salt',
      claimName: 'locality',
      claimValue: 'Zürich 😀'
    })
  })

  test('rejects disconnected, duplicated, and type-confused Disclosure graphs', () => {
    const objectDisclosure = base64UrlEncodeJson(['object-salt', 'role', 'admin'])
    const objectDigest = disclosureDigest(objectDisclosure)
    const arrayDisclosure = base64UrlEncodeJson(['array-salt', 'admin'])
    const arrayDigest = disclosureDigest(arrayDisclosure)

    expect(() => applyDisclosures({}, [objectDisclosure])).toThrow('not referenced')
    expect(() => applyDisclosures({ _sd: [arrayDigest] }, [arrayDisclosure])).toThrow(
      'Array-element Disclosure'
    )
    expect(() => applyDisclosures([{ '...': objectDigest }] as never, [objectDisclosure])).toThrow(
      'plain JSON object'
    )
    expect(() =>
      applyDisclosures({ values: [{ '...': objectDigest }] }, [objectDisclosure])
    ).toThrow('Object-property Disclosure')
    expect(() => applyDisclosures({ values: [{ '...': arrayDigest, extra: true }] }, [])).toThrow(
      'Invalid array Disclosure placeholder'
    )
    expect(() =>
      collectDigestPaths({ _sd: [objectDigest], nested: { _sd: [objectDigest] } })
    ).toThrow('more than once')
    expect(
      collectDigestPaths({
        values: [{ '...': arrayDigest }, { nested: { _sd: [objectDigest] } }]
      })
    ).toEqual(
      new Map([
        [arrayDigest, ['values', '0']],
        [objectDigest, ['values', '1', 'nested']]
      ])
    )
    expect(() => collectDigestPaths({ values: [{ '...': arrayDigest, extra: true }] })).toThrow(
      'Invalid array Disclosure placeholder'
    )
    expect(() => collectDigestPaths({ nested: { _sd_alg: 'sha-256' } })).toThrow(
      'only permitted at the top level'
    )
    expect(() => collectDigestPaths({ _sd: ['not-a-digest'] })).toThrow(
      'Invalid sha-256 Disclosure digest'
    )
  })

  test('rejects reserved/protected frames, mismatches, missing claims, and hostile frame ownership', () => {
    expect(() => makeSdPayload({ _sd: [] }, {})).toThrow('reserved claim')
    expect(() => makeSdPayload({ vct: credentialType }, { vct: true })).toThrow(
      'cannot be selectively disclosed'
    )
    expect(() => makeSdPayload({ profile: 'not-an-object' }, { profile: { name: true } })).toThrow(
      'does not match an object claim'
    )
    expect(() => makeSdPayload({ role: 'reader' }, { missing: true })).toThrow('missing claim')
    expect(() => createDisclosure('_sd', true)).toThrow('reserved')
    expect(() => parseDisclosure(base64UrlEncodeJson(['salt', 'array-value']))).toThrow(
      'object-property Disclosure'
    )

    const frameWithSymbol = { role: true }
    Object.defineProperty(frameWithSymbol, Symbol('hidden'), { value: true })
    expect(() => makeSdPayload({ role: 'reader' }, frameWithSymbol)).toThrow('symbol properties')

    let invoked = 0
    const frameWithAccessor = {}
    Object.defineProperty(frameWithAccessor, 'role', {
      enumerable: true,
      get() {
        invoked += 1
        return true
      }
    })
    expect(() => makeSdPayload({ role: 'reader' }, frameWithAccessor)).toThrow('own data property')
    expect(invoked).toBe(0)

    let deepFrame: Record<string, unknown> = { leaf: true }
    for (let index = 0; index <= MAX_JSON_DEPTH; index++) {
      deepFrame = { nested: deepFrame }
    }
    expect(() => makeSdPayload({}, deepFrame as never)).toThrow()
  })

  test('enforces bounded disclosure, digest, request, and path arrays without reading holes', () => {
    const digest = 'A'.repeat(43)
    expect(() => applyDisclosures({ _sd: Array(MAX_DISCLOSURES + 1).fill(digest) }, [])).toThrow(
      'bounded array of digests'
    )
    expect(() => applyDisclosures({}, Array(MAX_DISCLOSURES + 1).fill('A'))).toThrow(
      'bounded array'
    )
    expect(() => selectDisclosures({}, [], Array(MAX_DISCLOSURES + 1).fill('claim'))).toThrow(
      'bounded array'
    )

    const sparseDisclosures: string[] = []
    sparseDisclosures.length = 1
    expect(() => applyDisclosures({}, sparseDisclosures)).toThrow('own data string')
    const sparseClaims: string[] = []
    sparseClaims.length = 1
    expect(() => selectDisclosures({}, [], sparseClaims)).toThrow('own data string')
    const sparsePath: string[] = []
    sparsePath.length = 1
    expect(() => collectDigestPaths({}, sparsePath)).toThrow('own data string')
    expect(collectDigestPaths({}, ['root'])).toEqual(new Map())
    expect(() => collectDigestPaths({}, Array(MAX_JSON_DEPTH + 1).fill('nested'))).toThrow(
      'Invalid path'
    )

    const aggregate = Array.from({ length: 17 }, () => 'A'.repeat(65_536))
    expect(() => applyDisclosures({}, aggregate)).toThrow('aggregate limit')
    expect(() => selectDisclosures({}, [], ['x'.repeat(MAX_IDENTIFIER_BYTES + 1)])).toThrow(
      'invalid length'
    )
  })
})

describe('SD-JWT verifier policy boundaries', () => {
  test('requires complete Key Binding policy and a Key Binding JWT when requested', async () => {
    const incomplete = await SdJwtVcVerifier.verify(credential(), {
      requireKeyBinding: true,
      expectedAudience: 'https://verifier.example',
      now: 1_000
    })
    expect(incomplete.errors[0]).toContain('expectedAudience and expectedNonce')

    const missing = await SdJwtVcVerifier.verify(credential(), {
      requireKeyBinding: true,
      expectedAudience: 'https://verifier.example',
      expectedNonce: 'nonce-1',
      now: 1_000
    })
    expect(missing).toMatchObject({ verified: false, issuerSignedJwtVerified: true })
    expect(missing.errors[0]).toContain('Key Binding JWT is required')
  })

  test('rejects malformed policy types, ranges, unknown fields, and symbols', async () => {
    const cases: unknown[] = [
      { requireKeyBinding: 'yes' },
      { now: Infinity },
      { clockToleranceSeconds: -1 },
      { maxKeyBindingAgeSeconds: 86_401 },
      { unexpected: true }
    ]
    const symbolOptions = {}
    Object.defineProperty(symbolOptions, Symbol('hidden'), { value: true })
    cases.push(symbolOptions)

    for (const options of cases) {
      const result = await SdJwtVcVerifier.verify(credential(), options as never)
      expect(result.verified).toBe(false)
      expect(result.payload).toBeNull()
    }
  })

  test('binds issuer, type, URI syntax, and validity intervals', async () => {
    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      [
        'issuer mismatch',
        {},
        { expectedIssuer: BsvDid.fromPublicKey(new PrivateKey(23).toPublicKey()) }
      ],
      ['not a collision-resistant', { vct: 'relative-type' }, {}],
      ['type mismatch', {}, { expectedVct: 'urn:example:different' }],
      ['issued in the future', { iat: 1_001 }, { clockToleranceSeconds: 0 }],
      ['validity interval', { nbf: 1_000, exp: 1_000 }, { clockToleranceSeconds: 1 }]
    ]
    for (const [message, claims, options] of cases) {
      const result = await SdJwtVcVerifier.verify(credential(claims), {
        now: 1_000,
        ...options
      })
      expect(result.verified).toBe(false)
      expect(result.errors[0]).toContain(message)
    }
  })

  test('validates credential audiences as bounded unique strings', async () => {
    const accepted = await SdJwtVcVerifier.verify(
      credential({ aud: ['https://one.example', 'https://two.example'] }),
      { expectedCredentialAudience: 'https://two.example', now: 1_000 }
    )
    expect(accepted.verified).toBe(true)

    const cases: Array<[unknown, Record<string, unknown>, string]> = [
      ['https://one.example', { expectedCredentialAudience: 'https://two.example' }, 'mismatch'],
      [undefined, { expectedCredentialAudience: 'https://two.example' }, 'missing'],
      [[], { expectedCredentialAudience: 'https://two.example' }, 'bounded string array'],
      [
        Array(65).fill('https://one.example'),
        { expectedCredentialAudience: 'https://one.example' },
        'bounded string array'
      ],
      [['duplicate', 'duplicate'], { expectedCredentialAudience: 'duplicate' }, 'unique'],
      [[1], { expectedCredentialAudience: '1' }, 'must be a string']
    ]
    for (const [aud, options, message] of cases) {
      const claims = aud === undefined ? {} : { aud }
      const result = await SdJwtVcVerifier.verify(credential(claims), {
        now: 1_000,
        ...options
      })
      expect(result.verified).toBe(false)
      expect(result.errors[0]).toContain(message)
    }
  })

  test('rejects missing, private, or structurally incomplete cnf.jwk values', async () => {
    const publicJwk = publicKeyToJwk(holderPrivateKey.toPublicKey())
    for (const cnf of [
      {},
      { jwk: { ...publicJwk, d: 'private' } },
      { jwk: { kty: 'EC', crv: 'secp256k1', x: publicJwk.x } }
    ]) {
      const result = await SdJwtVcVerifier.verify(credential({ cnf }), { now: 1_000 })
      expect(result.verified).toBe(false)
      expect(result.errors[0]).toMatch(/cnf\.jwk/)
    }
  })
})
