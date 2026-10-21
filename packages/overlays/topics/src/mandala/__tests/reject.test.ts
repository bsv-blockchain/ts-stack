import { MandalaReject, Reasons, isMandalaReject } from '../reject.js'
import type { MandalaRejectCode } from '../reject.js'

// The reason catalog is a cross-engine contract: the Go overlay copies every
// string byte for byte (P3), so each row pins the exact text and code.
const op = `${'ab'.repeat(32)}.1`
const id = `${'cd'.repeat(32)}_0`
const k = `02${'ef'.repeat(32)}`

const catalog: Array<[string, MandalaReject, MandalaRejectCode, string]> = [
  [
    'invalidTokenOutput',
    Reasons.invalidTokenOutput(3, 'amount is not minimally encoded'),
    'ERR_SHAPE',
    'output 3: token-shaped output is not a valid BRC-162 token output (amount is not minimally encoded)'
  ],
  [
    'nonP2pkhRemainder',
    Reasons.nonP2pkhRemainder(2),
    'ERR_SHAPE',
    'output 2: token output remainder must be a P2PKH lock'
  ],
  [
    'oneSat',
    Reasons.oneSat(2),
    'ERR_SATOSHIS',
    'output 2: token output must carry exactly 1 satoshi'
  ],
  ['amountCap', Reasons.amountCap(4), 'ERR_SHAPE', 'output 4: token amount exceeds 2^53-1'],
  ['sumCap', Reasons.sumCap(id), 'ERR_SHAPE', `token ${id}: value sum exceeds 2^53-1`],
  [
    'supplyCap',
    Reasons.supplyCap(id),
    'ERR_SHAPE',
    `token ${id}: circulating supply would exceed 2^53-1`
  ],
  [
    'noLinkage',
    Reasons.noLinkage(1),
    'ERR_LINKAGE',
    'output 1: token output with no verified linkage'
  ],
  [
    'inputLinkageControl',
    Reasons.inputLinkageControl(0),
    'ERR_LINKAGE',
    'input 0: linkage does not control the coin being spent'
  ],
  [
    'inputLinkageOwner',
    Reasons.inputLinkageOwner(1, '02aa', '03bb'),
    'ERR_LINKAGE',
    'input 1: linkage names 02aa but the coin is owned by 03bb'
  ],
  [
    'ownerIndexUnavailable',
    Reasons.ownerIndexUnavailable(op),
    'ERR_UNAVAILABLE',
    `owner index unavailable for ${op}`
  ],
  [
    'storeUnavailable',
    Reasons.storeUnavailable('the owner index'),
    'ERR_UNAVAILABLE',
    'the owner index could not be read; retry'
  ],
  [
    'storeWriteUnavailable',
    Reasons.storeWriteUnavailable('the owner journal'),
    'ERR_UNAVAILABLE',
    'the owner journal could not be written; retry'
  ],
  [
    'untrustedOwner',
    Reasons.untrustedOwner(0, k),
    'ERR_UNTRUSTED',
    `output 0: owner ${k} is not a trusted issuer`
  ],
  [
    'untrustedProver',
    Reasons.untrustedProver(5, k),
    'ERR_UNTRUSTED',
    `output 5: linkage prover ${k} is not a trusted issuer`
  ],
  [
    'untrustedAuthorityInput',
    Reasons.untrustedAuthorityInput(2, k),
    'ERR_UNTRUSTED',
    `input 2: authority owner ${k} is not a trusted issuer`
  ],
  [
    'fixedSupply',
    Reasons.fixedSupply(),
    'ERR_AUTHORITY',
    'output 0: fixed-supply deploys are not allowed'
  ],
  [
    'deploySig',
    Reasons.deploySig(),
    'ERR_AUTHORITY',
    'output 0: deploy requires a valid deploySig over this txid'
  ],
  [
    'deployNotAtZero',
    Reasons.deployNotAtZero(1),
    'ERR_SHAPE',
    'output 1: a deploy must be output 0'
  ],
  [
    'authorityWithoutInput',
    Reasons.authorityWithoutInput(2, id),
    'ERR_AUTHORITY',
    `output 2: authority output without an admitted authority input of token ${id}`
  ],
  [
    'continuity',
    Reasons.continuity(id),
    'ERR_AUTHORITY',
    `token ${id}: spends an authority but creates none`
  ],
  [
    'twoCommitments',
    Reasons.twoCommitments(id),
    'ERR_AUTHORITY',
    `token ${id}: more than one authority output carries an action commitment`
  ],
  [
    'commitmentMismatch',
    Reasons.commitmentMismatch(1),
    'ERR_AUTHORITY',
    'output 1: admin details do not match the payload commitment'
  ],
  [
    'missingDetails',
    Reasons.missingDetails(1),
    'ERR_SHAPE',
    'output 1: committed authority output has no admin details'
  ],
  [
    'orphanDetails',
    Reasons.orphanDetails(3),
    'ERR_SHAPE',
    'admin entry 3 does not name a committed authority output'
  ],
  [
    'detailsSchema',
    Reasons.detailsSchema(1, 'unknown key amount'),
    'ERR_SHAPE',
    'output 1: admin details violate the schema (unknown key amount)'
  ],
  [
    'deployPayload',
    Reasons.deployPayload('missing key label'),
    'ERR_SHAPE',
    'output 0: deploy payload is not a valid Mandala deploy map (missing key label)'
  ],
  [
    'envelope',
    Reasons.envelope('must be an object'),
    'ERR_SHAPE',
    'Mandala payload must be an object'
  ],
  [
    'holderConservation',
    Reasons.holderConservation(id, 100n, 150n),
    'ERR_CONSERVATION',
    `token ${id}: value in 100 != value out 150 without an authority`
  ],
  [
    'holderConservation (number in)',
    Reasons.holderConservation(id, 0, 7n),
    'ERR_CONSERVATION',
    `token ${id}: value in 0 != value out 7 without an authority`
  ],
  [
    'deltaRule',
    Reasons.deltaRule(id, 'redeem', '< 0', 5n),
    'ERR_CONSERVATION',
    `token ${id}: redeem requires delta < 0 but delta is 5`
  ],
  [
    'deltaRule (negative)',
    Reasons.deltaRule(id, 'issue', '> 0', -3n),
    'ERR_CONSERVATION',
    `token ${id}: issue requires delta > 0 but delta is -3`
  ],
  [
    'reissue',
    Reasons.reissue(id, 'target is not frozen'),
    'ERR_SHAPE',
    `token ${id}: reissue target is not frozen`
  ],
  ['frozenInput', Reasons.frozenInput(0, op), 'ERR_FROZEN', `input 0: coin ${op} is frozen`],
  [
    'evictedInput',
    Reasons.evictedInput(2, op),
    'ERR_FROZEN',
    `input 2: coin ${op} was evicted by a reissue`
  ],
  ['paused', Reasons.paused(id), 'ERR_PAUSED', `token ${id} is paused`],
  ['blocked', Reasons.blocked(id, k), 'ERR_ACCESS', `token ${id}: ${k} is blocked (denylist)`],
  [
    'notAllowed',
    Reasons.notAllowed(id, k),
    'ERR_ACCESS',
    `token ${id}: ${k} is not allowlisted (allowlist)`
  ],
  ['sanctioned', Reasons.sanctioned(k), 'ERR_SANCTIONED', `identity ${k} is sanctioned`],
  [
    'notMember',
    Reasons.notMember(k),
    'ERR_MEMBERSHIP',
    `identity ${k} is not an admitted registry member`
  ],
  [
    'registryExists',
    Reasons.registryExists(),
    'ERR_SHAPE',
    'tm_mandala_registry: registration chain already exists; register is genesis-only'
  ],
  [
    'registryValue',
    Reasons.registryValue(1),
    'ERR_SHAPE',
    'output 1: tm_mandala_registry does not admit value outputs'
  ]
]

describe('Mandala reason catalog', () => {
  test.each(catalog)('%s', (_name, reject, code, reason) => {
    expect(reject).toBeInstanceOf(MandalaReject)
    expect(reject).toBeInstanceOf(Error)
    expect(reject.name).toBe('MandalaReject')
    expect(reject.code).toBe(code)
    expect(reject.reason).toBe(reason)
    expect(reject.message).toBe(reason)
    expect(isMandalaReject(reject)).toBe(true)
  })

  test('covers every catalog function', () => {
    const named = new Set(catalog.map(([name]) => name.split(' ')[0]))
    expect([...named].sort()).toEqual(Object.keys(Reasons).sort())
  })

  test('throws as an Error with the reason as its message', () => {
    expect(() => {
      throw Reasons.oneSat(2)
    }).toThrow('output 2: token output must carry exactly 1 satoshi')
  })
})

describe('MandalaReject', () => {
  test('keeps the cause it is given', () => {
    const cause = new Error('mongo down')
    const reject = new MandalaReject('ERR_UNAVAILABLE', 'store down', { cause })
    expect(reject.cause).toBe(cause)
    expect(reject.code).toBe('ERR_UNAVAILABLE')
    expect(reject.reason).toBe('store down')
  })

  test('has no cause by default', () => {
    expect(new MandalaReject('ERR_SHAPE', 'x').cause).toBeUndefined()
  })

  test('an infra reject keeps the fault it is given as its cause, and has none otherwise', () => {
    const cause = new Error('mongo down')
    expect(Reasons.storeUnavailable('the owner index', cause).cause).toBe(cause)
    expect(Reasons.storeWriteUnavailable('the owner index', cause).cause).toBe(cause)
    expect('cause' in Reasons.storeUnavailable('the owner index')).toBe(false)
    expect('cause' in Reasons.ownerIndexUnavailable(op)).toBe(false)
  })
})

describe('isMandalaReject', () => {
  test('is structural: a plain object with the name, a known code and a reason', () => {
    expect(isMandalaReject({ name: 'MandalaReject', code: 'ERR_SHAPE', reason: 'x' })).toBe(true)
  })

  test.each([
    ['a plain Error', new Error('x')],
    ['an unknown code', { name: 'MandalaReject', code: 'ERR_NOPE', reason: 'x' }],
    ['a missing code', { name: 'MandalaReject', reason: 'x' }],
    ['another name', { name: 'Error', code: 'ERR_SHAPE', reason: 'x' }],
    ['a non-string reason', { name: 'MandalaReject', code: 'ERR_SHAPE', reason: 1 }],
    ['a missing reason', { name: 'MandalaReject', code: 'ERR_SHAPE' }],
    ['an inherited code name', { name: 'MandalaReject', code: 'toString', reason: 'x' }],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'MandalaReject'],
    ['a number', 7]
  ])('rejects %s', (_label, value) => {
    expect(isMandalaReject(value)).toBe(false)
  })

  test.each([
    'ERR_SHAPE',
    'ERR_SATOSHIS',
    'ERR_LINKAGE',
    'ERR_CONSERVATION',
    'ERR_AUTHORITY',
    'ERR_UNTRUSTED',
    'ERR_PAUSED',
    'ERR_FROZEN',
    'ERR_ACCESS',
    'ERR_SANCTIONED',
    'ERR_MEMBERSHIP',
    'ERR_UNAVAILABLE'
  ])('accepts code %s', code => {
    expect(isMandalaReject({ name: 'MandalaReject', code, reason: 'x' })).toBe(true)
  })
})
