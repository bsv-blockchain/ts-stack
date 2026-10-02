import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hash, PublicKey } from '@bsv/sdk'
import { encodeStrictCbor } from '@bsv/templates'
import { isMandalaReject } from '../reject.js'
import {
  ADMIN_KINDS,
  REGISTRY_KINDS,
  commitmentOf,
  decodeAdminDetails,
  deployMetadata,
  encodeAdminDetails
} from '../details.js'
import type { AdminDetails } from '../details.js'

interface CommitmentVector {
  id: string
  detailsHex: string
  commitment: string
}

// The templates package pins one details map per §3.3 kind; the overlay must
// read exactly those bytes and reproduce exactly those commitments. The file is
// found by walking up to the repository root rather than by a fixed relative
// path, so the test also runs from a copy of this package (the mutation
// sandbox lives inside the package directory).
const VECTORS_FROM_ROOT = 'packages/helpers/ts-templates/test/vectors/brc162.json'

function findVectors(start: string): string {
  let directory = start
  while (!existsSync(resolve(directory, VECTORS_FROM_ROOT))) {
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`${VECTORS_FROM_ROOT} not found above ${start}`)
    directory = parent
  }
  return resolve(directory, VECTORS_FROM_ROOT)
}

const vectorsPath = findVectors(dirname(fileURLToPath(import.meta.url)))
const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8')) as {
  commitments: CommitmentVector[]
}

const hexOf = (bytes: readonly number[]): string =>
  bytes.map(b => b.toString(16).padStart(2, '0')).join('')
const bytesOfHex = (hex: string): number[] => (hex.match(/../g) ?? []).map(h => parseInt(h, 16))
const cborHex = (map: Parameters<typeof encodeStrictCbor>[0]): string =>
  hexOf(encodeStrictCbor(map))
const bytes = (length: number, fill = 7): Uint8Array => Uint8Array.from({ length }, () => fill)

const IDENTITY = '027fd738cb67baa2c6818850e56b2c7fe7de87130964dc1c2210b143a8e97bd0a6'
const RECIPIENT = '038c44b639733c7893760b8b6a954f79f0e76d71bbc10da8a761be1dae262421ff'
const OUTPOINT = 'e9e2dbd4cdc6bfb8b1aaa39c958e878079726b645d564f48413a332c251e1710.1'
const BANK_REF = Array.from({ length: 32 }, (_, i) => (0x40 + i * 7) & 0xff)

const EXPECTED: Record<string, AdminDetails> = {
  'issue-bankref': { kind: 'issue', bankRef: BANK_REF },
  'issue-no-bankref': { kind: 'issue' },
  'issue-bankref-reason': { kind: 'issue', bankRef: BANK_REF, reason: 'wire 4711' },
  redeem: { kind: 'redeem' },
  reissue: { kind: 'reissue', outpoint: OUTPOINT, recipient: RECIPIENT },
  pause: { kind: 'pause' },
  unpause: { kind: 'unpause', reason: 'incident closed' },
  blockIdentity: { kind: 'blockIdentity', identityKey: IDENTITY },
  unblockIdentity: { kind: 'unblockIdentity', identityKey: IDENTITY },
  allowIdentity: { kind: 'allowIdentity', identityKey: IDENTITY },
  unallowIdentity: { kind: 'unallowIdentity', identityKey: IDENTITY },
  'setAccessMode-denylist': { kind: 'setAccessMode', mode: 'denylist' },
  'setAccessMode-allowlist': { kind: 'setAccessMode', mode: 'allowlist' },
  freezeOutput: { kind: 'freezeOutput', outpoint: OUTPOINT },
  unfreezeOutput: { kind: 'unfreezeOutput', outpoint: OUTPOINT },
  setFeeRate: { kind: 'setFeeRate', feeRatePerKb: 1000 },
  'setFeeRate-disabled': { kind: 'setFeeRate', feeRatePerKb: null },
  admitIdentity: { kind: 'admitIdentity', identityKey: IDENTITY },
  revokeIdentity: { kind: 'revokeIdentity', identityKey: IDENTITY }
}

const ALL_KINDS: readonly string[] = [...ADMIN_KINDS, ...REGISTRY_KINDS]
const kindsFor = (kind: string): readonly string[] =>
  (REGISTRY_KINDS as readonly string[]).includes(kind) ? REGISTRY_KINDS : ADMIN_KINDS

const thrownBy = (run: () => unknown): unknown => {
  try {
    run()
  } catch (e) {
    return e
  }
  throw new Error('expected a throw')
}

const expectReject = (run: () => unknown, reason: string): void => {
  const thrown = thrownBy(run)
  expect(isMandalaReject(thrown)).toBe(true)
  expect(thrown).toMatchObject({ code: 'ERR_SHAPE', reason })
}

const expectSchemaReject = (hex: string, detail: string, allowed = ALL_KINDS): void => {
  expectReject(
    () => decodeAdminDetails(hex, allowed, 4),
    `output 4: admin details violate the schema (${detail})`
  )
}

describe('admin details kinds', () => {
  test('admin and registry kinds per §3.3', () => {
    expect(ADMIN_KINDS).toEqual([
      'issue',
      'redeem',
      'reissue',
      'pause',
      'unpause',
      'blockIdentity',
      'unblockIdentity',
      'allowIdentity',
      'unallowIdentity',
      'setAccessMode',
      'freezeOutput',
      'unfreezeOutput',
      'setFeeRate'
    ])
    expect(REGISTRY_KINDS).toEqual(['admitIdentity', 'revokeIdentity'])
  })

  test('the templates vectors cover every kind', () => {
    const kinds = new Set(Object.values(EXPECTED).map(d => d.kind))
    expect([...kinds].sort()).toEqual([...ALL_KINDS].sort())
    expect(vectors.commitments.map(v => v.id).sort()).toEqual(Object.keys(EXPECTED).sort())
  })
})

describe('decodeAdminDetails against the templates vectors', () => {
  test.each(vectors.commitments.map(v => [v.id, v] as const))('%s', (id, v) => {
    const { details, commitment } = decodeAdminDetails(v.detailsHex, kindsFor(EXPECTED[id].kind), 1)
    expect(details).toStrictEqual(EXPECTED[id])
    expect(hexOf(commitment)).toBe(v.commitment)
    expect(hexOf(Hash.sha256(bytesOfHex(v.detailsHex)))).toBe(v.commitment)
    expect(hexOf(encodeAdminDetails(details))).toBe(v.detailsHex)
  })
})

describe('encodeAdminDetails', () => {
  test.each(Object.entries(EXPECTED))('round-trips %s', (_id, details) => {
    const encoded = encodeAdminDetails(details)
    const decoded = decodeAdminDetails(hexOf(encoded), ALL_KINDS, 0)
    expect(decoded.details).toStrictEqual(details)
    expect(decoded.commitment).toEqual(Hash.sha256(encoded))
  })

  test('writes the outpoint as txid in natural order then the uint32 LE vout', () => {
    const txid = `${'00'.repeat(31)}01`
    const encoded = encodeAdminDetails({ kind: 'freezeOutput', outpoint: `${txid}.4294967295` })
    expect(hexOf(encoded)).toBe(
      cborHex({
        kind: 'freezeOutput',
        outpoint: Uint8Array.from([1, ...bytes(31, 0), 255, 255, 255, 255])
      })
    )
    expect(decodeAdminDetails(hexOf(encoded), ALL_KINDS, 0).details.outpoint).toBe(
      `${txid}.4294967295`
    )
  })

  test('leaves absent optional keys out', () => {
    expect(hexOf(encodeAdminDetails({ kind: 'issue' }))).toBe('a1646b696e64656973737565')
  })

  test.each([
    ['no vout', 'ab'.repeat(32)],
    ['a short txid', `${'ab'.repeat(31)}.0`],
    ['an uppercase txid', `${'AB'.repeat(32)}.0`],
    ['a vout above 2^32-1', `${'ab'.repeat(32)}.4294967296`],
    ['a leading-zero vout', `${'ab'.repeat(32)}.01`],
    ['a negative vout', `${'ab'.repeat(32)}.-1`]
  ])('refuses an outpoint with %s', (_label, outpoint) => {
    expect(() => encodeAdminDetails({ kind: 'freezeOutput', outpoint })).toThrow(
      'outpoint must be <64 lowercase hex txid>.<vout 0..4294967295>'
    )
  })
})

describe('decodeAdminDetails schema', () => {
  const key = Uint8Array.from(bytesOfHex(IDENTITY))

  test('decodes the largest fee rate and the largest vout', () => {
    const fee = cborHex({ kind: 'setFeeRate', feeRatePerKb: Number.MAX_SAFE_INTEGER })
    expect(decodeAdminDetails(fee, ADMIN_KINDS, 0).details.feeRatePerKb).toBe(
      Number.MAX_SAFE_INTEGER
    )
    const outpoint = Uint8Array.from([...bytes(32, 0xaa), 0xff, 0xff, 0xff, 0xff])
    expect(
      decodeAdminDetails(cborHex({ kind: 'freezeOutput', outpoint }), ADMIN_KINDS, 0).details
        .outpoint
    ).toBe(`${'aa'.repeat(32)}.4294967295`)
  })

  test('the commitment is SHA-256 of the exact detail bytes', () => {
    const hex = cborHex({ kind: 'pause', reason: 'audit' })
    expect(decodeAdminDetails(hex, ADMIN_KINDS, 0).commitment).toEqual(Hash.sha256(bytesOfHex(hex)))
  })

  test.each([
    ['unknown key amount', { kind: 'issue', amount: 5 }],
    ['unknown key bankRef', { kind: 'redeem', bankRef: bytes(32) }],
    ['unknown key identityKey', { kind: 'pause', identityKey: key }],
    ['unknown key assetId', { kind: 'blockIdentity', identityKey: key, assetId: 'x' }],
    ['unknown key priorOutpoint', { kind: 'reissue', priorOutpoint: bytes(36) }],
    ['missing key outpoint', { kind: 'reissue', recipient: key }],
    ['missing key recipient', { kind: 'reissue', outpoint: bytes(36) }],
    ['missing key identityKey', { kind: 'allowIdentity' }],
    ['missing key mode', { kind: 'setAccessMode' }],
    ['missing key outpoint', { kind: 'unfreezeOutput' }],
    ['missing key feeRatePerKb', { kind: 'setFeeRate' }],
    ['missing key identityKey', { kind: 'revokeIdentity' }],
    ['missing key kind', { reason: 'x' }],
    ['kind must be text', { kind: 1 }],
    ['kind must be text', { kind: bytes(4) }],
    ['kind mint is not allowed', { kind: 'mint' }],
    ['kind toString is not allowed', { kind: 'toString' }],
    ['bankRef must be 32 bytes', { kind: 'issue', bankRef: bytes(31) }],
    ['bankRef must be 32 bytes', { kind: 'issue', bankRef: bytes(33) }],
    ['bankRef must be 32 bytes', { kind: 'issue', bankRef: 'ref' }],
    ['outpoint must be 36 bytes', { kind: 'freezeOutput', outpoint: bytes(35) }],
    ['outpoint must be 36 bytes', { kind: 'freezeOutput', outpoint: 'ab.0' }],
    [
      'recipient must be a 33-byte compressed public key',
      { kind: 'reissue', outpoint: bytes(36), recipient: bytes(32) }
    ],
    [
      'identityKey must be a 33-byte compressed public key',
      { kind: 'blockIdentity', identityKey: key.subarray(0, 32) }
    ],
    [
      'identityKey must be a 33-byte compressed public key',
      { kind: 'blockIdentity', identityKey: IDENTITY }
    ],
    ['mode must be denylist or allowlist', { kind: 'setAccessMode', mode: 'open' }],
    ['mode must be denylist or allowlist', { kind: 'setAccessMode', mode: 'Denylist' }],
    ['mode must be denylist or allowlist', { kind: 'setAccessMode', mode: 1 }],
    ['feeRatePerKb must be a safe integer >= 1 or null', { kind: 'setFeeRate', feeRatePerKb: 0 }],
    [
      'feeRatePerKb must be a safe integer >= 1 or null',
      { kind: 'setFeeRate', feeRatePerKb: 2n ** 53n }
    ],
    [
      'feeRatePerKb must be a safe integer >= 1 or null',
      { kind: 'setFeeRate', feeRatePerKb: '1000' }
    ],
    [
      'feeRatePerKb must be a safe integer >= 1 or null',
      { kind: 'setFeeRate', feeRatePerKb: false }
    ],
    ['reason must be text', { kind: 'pause', reason: 1 }],
    ['reason must be text', { kind: 'pause', reason: null }]
  ])('%s', (detail, map) => {
    expectSchemaReject(cborHex(map as Parameters<typeof encodeStrictCbor>[0]), detail)
  })

  test('an uncompressed key is refused', () => {
    const uncompressed = PublicKey.fromString(IDENTITY).encode(false) as number[]
    expect(uncompressed).toHaveLength(65)
    expectSchemaReject(
      cborHex({ kind: 'blockIdentity', identityKey: Uint8Array.from(uncompressed) }),
      'identityKey must be a 33-byte compressed public key'
    )
  })

  test.each([
    ['an uncompressed prefix', `04${IDENTITY.slice(2)}`],
    ['a hybrid prefix', `06${IDENTITY.slice(2)}`],
    ['an x that is not on the curve', `02${'00'.repeat(32)}`],
    // x = 1 + p reduces to the valid x = 1: the SDK accepts it, the strict reader must not.
    ['an x at or above the field prime', `02${'ff'.repeat(27)}fefffffc30`]
  ])('a 33-byte key with %s is refused', (_label, hex) => {
    expectSchemaReject(
      cborHex({
        kind: 'reissue',
        outpoint: bytes(36),
        recipient: Uint8Array.from(bytesOfHex(hex))
      }),
      'recipient must be a 33-byte compressed public key'
    )
  })

  test('the x = 1 + p alias really parses in the SDK (so the test above is meaningful)', () => {
    const alias = bytesOfHex(`02${'ff'.repeat(27)}fefffffc30`)
    expect(PublicKey.fromDER(alias).toString()).toBe(`02${'00'.repeat(31)}01`)
  })

  test('registry kinds are refused where only admin kinds are allowed, and vice versa', () => {
    const admit = cborHex({ kind: 'admitIdentity', identityKey: key })
    expectSchemaReject(admit, 'kind admitIdentity is not allowed', ADMIN_KINDS)
    const issue = cborHex({ kind: 'issue' })
    expectSchemaReject(issue, 'kind issue is not allowed', REGISTRY_KINDS)
  })

  test('a caller-allowed kind with no §3.3 schema is refused', () => {
    expectSchemaReject(cborHex({ kind: 'register' }), 'kind register is not allowed', ['register'])
  })

  test('kind is checked before unknown keys, and unknown keys before required keys', () => {
    expectSchemaReject(cborHex({ kind: 'mint', extra: 1 }), 'kind mint is not allowed')
    expectSchemaReject(cborHex({ kind: 'reissue', extra: 1 }), 'unknown key extra')
  })

  test('the first unknown key is reported in CBOR key order, not JS property order', () => {
    // JS lists the integer-like key "10" first; CBOR orders the shorter key "z" first.
    expectSchemaReject(cborHex({ kind: 'pause', 10: 1, z: 1, zz: 1 }), 'unknown key z')
    expectSchemaReject(cborHex({ kind: 'pause', 10: 1, zz: 1 }), 'unknown key 10')
  })

  test('required keys are read before optional ones, then reason', () => {
    expectSchemaReject(
      cborHex({ kind: 'reissue', outpoint: bytes(1), recipient: bytes(1), reason: 1 }),
      'outpoint must be 36 bytes'
    )
    expectSchemaReject(
      cborHex({ kind: 'issue', bankRef: bytes(1), reason: 1 }),
      'bankRef must be 32 bytes'
    )
  })

  test.each([
    // feeRatePerKb: 1.0 as a half float (f9 3c00) in place of the uint 1000 (19 03e8).
    [
      'a float',
      'a2646b696e646a736574466565526174656c666565526174655065724b62f93c00',
      'simple value or float not allowed'
    ],
    // bankRef wrapped in tag 42 (d8 2a).
    [
      'a tag',
      `a2646b696e646569737375656762616e6b526566d82a5820${'07'.repeat(32)}`,
      'major type 6 not allowed'
    ],
    ['a negative integer', 'a2617820646b696e64657061757365', 'major type 1 not allowed'],
    ['an array', 'a1646b696e6481657061757365', 'major type 4 not allowed'],
    ['unsorted keys', 'a2646b696e64657061757365617801', 'map keys unsorted or duplicated'],
    ['a non-text key', 'a2016178646b696e64657061757365', 'map key must be text'],
    ['trailing bytes', 'a1646b696e6465706175736500', 'trailing bytes'],
    ['a non-map top level', '657061757365', 'top level must be a map']
  ])('non-strict CBOR (%s) passes the codec message through', (_label, hex, detail) => {
    expectSchemaReject(hex, detail)
  })

  test('details that are not lowercase hex are refused', () => {
    expectSchemaReject('A1646B696E64657061757365', 'details must be lowercase hex')
    expectSchemaReject('', 'details must be lowercase hex')
  })
})

describe('deployMetadata', () => {
  const deploy = (map: Parameters<typeof encodeStrictCbor>[0]): number[] => encodeStrictCbor(map)
  const expectDeployReject = (payload: number[] | undefined, detail: string, canonical = true) => {
    expectReject(
      () => deployMetadata(payload, canonical),
      `output 0: deploy payload is not a valid Mandala deploy map (${detail})`
    )
  }

  test('reads sym, dec and label, and defaults the fee rate to null', () => {
    expect(deployMetadata(deploy({ sym: 'USD', dec: 2, label: 'US Dollar' }), true)).toStrictEqual({
      sym: 'USD',
      dec: 2,
      label: 'US Dollar',
      feeRatePerKb: null
    })
  })

  test('the §3.5 example {sym, dec} lacks the Mandala label', () => {
    expect(hexOf(deploy({ sym: 'USD', dec: 2 }))).toBe('a263646563026373796d63555344')
    expectDeployReject(bytesOfHex('a263646563026373796d63555344'), 'missing key label')
  })

  test.each([
    [1000, 1000],
    [null, null],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]
  ])('reads feeRatePerKb %p', (fee, expected) => {
    expect(
      deployMetadata(deploy({ sym: 'S', dec: 0, label: 'L', feeRatePerKb: fee }), true).feeRatePerKb
    ).toBe(expected)
  })

  test('ignores unknown keys (BRC-162)', () => {
    const payload = deploy({ sym: 'S', dec: 18, label: 'L', icon: bytes(3), meta: { a: 1 } })
    expect(deployMetadata(payload, true)).toStrictEqual({
      sym: 'S',
      dec: 18,
      label: 'L',
      feeRatePerKb: null
    })
  })

  test('counts characters as Unicode code points', () => {
    const sym = '€'.repeat(32)
    const label = '😀'.repeat(64)
    expect(deployMetadata(deploy({ sym, dec: 0, label }), true)).toMatchObject({ sym, label })
    expectDeployReject(
      deploy({ sym: '😀'.repeat(33), dec: 0, label: 'L' }),
      'sym must be text of 1-32 characters'
    )
    expectDeployReject(
      deploy({ sym: 'S', dec: 0, label: '€'.repeat(65) }),
      'label must be text of 1-64 characters'
    )
  })

  test.each([
    ['missing key sym', { dec: 2, label: 'L' }],
    ['missing key dec', { sym: 'S', label: 'L' }],
    ['missing key label', { sym: 'S', dec: 2 }],
    ['sym must be text of 1-32 characters', { sym: '', dec: 2, label: 'L' }],
    ['sym must be text of 1-32 characters', { sym: 'S'.repeat(33), dec: 2, label: 'L' }],
    ['sym must be text of 1-32 characters', { sym: bytes(3), dec: 2, label: 'L' }],
    ['dec must be an integer 0-18', { sym: 'S', dec: 19, label: 'L' }],
    ['dec must be an integer 0-18', { sym: 'S', dec: '2', label: 'L' }],
    ['dec must be an integer 0-18', { sym: 'S', dec: null, label: 'L' }],
    ['label must be text of 1-64 characters', { sym: 'S', dec: 2, label: '' }],
    ['label must be text of 1-64 characters', { sym: 'S', dec: 2, label: 'L'.repeat(65) }],
    ['label must be text of 1-64 characters', { sym: 'S', dec: 2, label: true }],
    [
      'feeRatePerKb must be a safe integer >= 1 or null',
      { sym: 'S', dec: 2, label: 'L', feeRatePerKb: 0 }
    ],
    [
      'feeRatePerKb must be a safe integer >= 1 or null',
      { sym: 'S', dec: 2, label: 'L', feeRatePerKb: 2n ** 53n }
    ],
    [
      'feeRatePerKb must be a safe integer >= 1 or null',
      { sym: 'S', dec: 2, label: 'L', feeRatePerKb: 'x' }
    ]
  ])('%s', (detail, map) => {
    expectDeployReject(deploy(map as Parameters<typeof encodeStrictCbor>[0]), detail)
  })

  test('accepts the boundary lengths', () => {
    const meta = deployMetadata(
      deploy({ sym: 'S'.repeat(32), dec: 0, label: 'L'.repeat(64) }),
      true
    )
    expect(meta.sym).toHaveLength(32)
    expect(meta.label).toHaveLength(64)
  })

  test('checks sym, then dec, then label, then feeRatePerKb', () => {
    expectDeployReject(deploy({ dec: 99, label: '', feeRatePerKb: 0 }), 'missing key sym')
    expectDeployReject(deploy({ sym: 'S', dec: 99, label: '' }), 'dec must be an integer 0-18')
    expectDeployReject(
      deploy({ sym: 'S', dec: 1, label: '', feeRatePerKb: 0 }),
      'label must be text of 1-64 characters'
    )
  })

  test('refuses a missing payload', () => {
    expectDeployReject(undefined, 'missing payload')
  })

  test('refuses a non-canonical payload push', () => {
    expectDeployReject(
      deploy({ sym: 'S', dec: 2, label: 'L' }),
      'non-canonical payload push',
      false
    )
  })

  test.each([
    ['a non-map', [0x63, 0x55, 0x53, 0x44], 'top level must be a map'],
    ['an empty payload', [], 'truncated input'],
    // {sym, dec: 1.0} — accepted by a lenient decoder, never by Mandala (Review Focus 2).
    [
      'a float dec',
      bytesOfHex('a263646563f93c006373796d63555344'),
      'simple value or float not allowed'
    ]
  ])('refuses %s', (_label, payload, detail) => {
    expectDeployReject(payload, detail)
  })
})

describe('commitmentOf', () => {
  const adm = bytes(32, 0xab)

  test('reads {adm: bytes(32)}', () => {
    expect(commitmentOf(encodeStrictCbor({ adm }), true)).toEqual(Array.from(adm))
  })

  test('ignores other keys next to adm (BRC-162)', () => {
    expect(commitmentOf(encodeStrictCbor({ adm, note: 'x' }), true)).toEqual(Array.from(adm))
  })

  test.each([
    ['no payload', undefined, true],
    ['a non-canonical push', encodeStrictCbor({ adm }), false],
    ['no adm key', encodeStrictCbor({ sym: 'S' }), true],
    ['a 31-byte adm', encodeStrictCbor({ adm: bytes(31) }), true],
    ['a 33-byte adm', encodeStrictCbor({ adm: bytes(33) }), true],
    ['a text adm', encodeStrictCbor({ adm: 'ab'.repeat(32) }), true],
    ['an empty payload', [], true],
    ['non-strict CBOR', [0xa1, 0x63, 0x61, 0x64, 0x6d, 0xf9, 0x3c, 0x00], true],
    ['trailing bytes', [...encodeStrictCbor({ adm }), 0], true]
  ])('is undefined for %s', (_label, payload, canonical) => {
    expect(commitmentOf(payload, canonical)).toBeUndefined()
  })
})
