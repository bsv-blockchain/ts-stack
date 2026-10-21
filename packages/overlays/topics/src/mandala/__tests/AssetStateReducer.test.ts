import { defaultAssetState, foldAction } from '../AssetStateReducer.js'
import type { AssetAdminState, FoldContext } from '../AssetStateReducer.js'
import type { AdminDetails } from '../details.js'

const TOKEN = `${'ab'.repeat(32)}_0`
const KEY_A = `02${'aa'.repeat(32)}`
const KEY_B = `03${'bb'.repeat(32)}`
const OUT_1 = `${'11'.repeat(32)}.1`
const OUT_2 = `${'22'.repeat(32)}.2`

const S = (over: Partial<AssetAdminState> = {}): AssetAdminState => ({
  ...defaultAssetState(TOKEN),
  ...over
})
const D = (details: AdminDetails): AdminDetails => details

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

describe('defaultAssetState', () => {
  it('starts unpaused, on the denylist, empty, with the token id and no fee rate', () => {
    expect(defaultAssetState(TOKEN)).toEqual({
      tokenId: TOKEN,
      isPaused: false,
      accessMode: 'denylist',
      blockedIdentities: [],
      allowedIdentities: [],
      frozenOutpoints: [],
      evictedOutpoints: [],
      feeRatePerKb: null,
      lastProcessedHeight: 0,
      lastProcessedOffset: 0,
      lastAdmitSeq: 0
    })
  })

  it('carries a deploy fee rate', () => {
    expect(defaultAssetState('x', 5)).toMatchObject({ tokenId: 'x', feeRatePerKb: 5 })
    expect(defaultAssetState('x', null).feeRatePerKb).toBeNull()
  })

  it('does not share arrays between states', () => {
    const a = defaultAssetState(TOKEN)
    const b = defaultAssetState(TOKEN)
    expect(a.blockedIdentities).not.toBe(b.blockedIdentities)
    expect(a.frozenOutpoints).not.toBe(b.frozenOutpoints)
  })
})

describe('foldAction', () => {
  it('pause and unpause set the flag', () => {
    const paused = foldAction(S(), D({ kind: 'pause' }))
    expect(paused.isPaused).toBe(true)
    expect(foldAction(paused, D({ kind: 'unpause' })).isPaused).toBe(false)
  })

  it('blockIdentity is idempotent and stores lowercase keys', () => {
    let s = foldAction(S(), D({ kind: 'blockIdentity', identityKey: KEY_A.toUpperCase() }))
    expect(s.blockedIdentities).toEqual([KEY_A])
    s = foldAction(s, D({ kind: 'blockIdentity', identityKey: KEY_A }))
    s = foldAction(s, D({ kind: 'blockIdentity', identityKey: KEY_B }))
    expect(s.blockedIdentities).toEqual([KEY_A, KEY_B])
  })

  it('unblockIdentity removes by lowercase key and is idempotent', () => {
    let s = S({ blockedIdentities: [KEY_A, KEY_B] })
    s = foldAction(s, D({ kind: 'unblockIdentity', identityKey: KEY_A.toUpperCase() }))
    expect(s.blockedIdentities).toEqual([KEY_B])
    s = foldAction(s, D({ kind: 'unblockIdentity', identityKey: KEY_A }))
    expect(s.blockedIdentities).toEqual([KEY_B])
  })

  it('allowIdentity and unallowIdentity touch the allowlist only', () => {
    let s = foldAction(S(), D({ kind: 'allowIdentity', identityKey: KEY_B.toUpperCase() }))
    expect(s.allowedIdentities).toEqual([KEY_B])
    expect(s.blockedIdentities).toEqual([])
    s = foldAction(s, D({ kind: 'allowIdentity', identityKey: KEY_B }))
    expect(s.allowedIdentities).toEqual([KEY_B])
    s = foldAction(s, D({ kind: 'unallowIdentity', identityKey: KEY_B.toUpperCase() }))
    expect(s.allowedIdentities).toEqual([])
    s = foldAction(s, D({ kind: 'unallowIdentity', identityKey: KEY_B }))
    expect(s.allowedIdentities).toEqual([])
  })

  it('blockIdentity does not touch the allowlist', () => {
    const s = foldAction(
      S({ allowedIdentities: [KEY_A] }),
      D({ kind: 'blockIdentity', identityKey: KEY_B })
    )
    expect(s.allowedIdentities).toEqual([KEY_A])
    expect(s.blockedIdentities).toEqual([KEY_B])
  })

  it('setAccessMode sets the mode', () => {
    const allow = foldAction(S(), D({ kind: 'setAccessMode', mode: 'allowlist' }))
    expect(allow.accessMode).toBe('allowlist')
    expect(foldAction(allow, D({ kind: 'setAccessMode', mode: 'denylist' })).accessMode).toBe(
      'denylist'
    )
  })

  it('freezeOutput records outpoint, amount and owner from the context', () => {
    const ctx: FoldContext = { frozenAmount: 30, frozenOwner: KEY_A }
    const s = foldAction(S(), D({ kind: 'freezeOutput', outpoint: OUT_1 }), ctx)
    expect(s.frozenOutpoints).toEqual([{ outpoint: OUT_1, amount: 30, owner: KEY_A }])
  })

  it('freezeOutput without a context records amount 0 and an empty owner', () => {
    const s = foldAction(S(), D({ kind: 'freezeOutput', outpoint: OUT_1 }))
    expect(s.frozenOutpoints).toEqual([{ outpoint: OUT_1, amount: 0, owner: '' }])
  })

  it('freezeOutput records an outpoint once and keeps the first row', () => {
    let s = foldAction(S(), D({ kind: 'freezeOutput', outpoint: OUT_1 }), {
      frozenAmount: 30,
      frozenOwner: KEY_A
    })
    s = foldAction(s, D({ kind: 'freezeOutput', outpoint: OUT_1.toUpperCase() }), {
      frozenAmount: 99,
      frozenOwner: KEY_B
    })
    expect(s.frozenOutpoints).toEqual([{ outpoint: OUT_1, amount: 30, owner: KEY_A }])
    s = foldAction(s, D({ kind: 'freezeOutput', outpoint: OUT_2 }), { frozenAmount: 7 })
    expect(s.frozenOutpoints.map(f => f.outpoint)).toEqual([OUT_1, OUT_2])
  })

  it('unfreezeOutput removes the row by outpoint and leaves the others', () => {
    const rows = [
      { outpoint: OUT_1, amount: 30, owner: KEY_A },
      { outpoint: OUT_2, amount: 5, owner: KEY_B }
    ]
    let s = foldAction(S({ frozenOutpoints: rows }), D({ kind: 'unfreezeOutput', outpoint: OUT_1 }))
    expect(s.frozenOutpoints).toEqual([rows[1]])
    s = foldAction(s, D({ kind: 'unfreezeOutput', outpoint: OUT_1 }))
    expect(s.frozenOutpoints).toEqual([rows[1]])
  })

  it('reissue moves the outpoint from frozen to evicted', () => {
    const frozen = S({
      frozenOutpoints: [
        { outpoint: OUT_1, amount: 30, owner: KEY_A },
        { outpoint: OUT_2, amount: 5, owner: KEY_B }
      ]
    })
    const s = foldAction(frozen, D({ kind: 'reissue', outpoint: OUT_1, recipient: KEY_B }))
    expect(s.frozenOutpoints).toEqual([{ outpoint: OUT_2, amount: 5, owner: KEY_B }])
    expect(s.evictedOutpoints).toEqual([OUT_1])
  })

  it('reissue records an eviction once', () => {
    const frozen = S({ frozenOutpoints: [{ outpoint: OUT_1, amount: 30, owner: KEY_A }] })
    const once = foldAction(frozen, D({ kind: 'reissue', outpoint: OUT_1, recipient: KEY_B }))
    const twice = foldAction(
      once,
      D({ kind: 'reissue', outpoint: OUT_1.toUpperCase(), recipient: KEY_B })
    )
    expect(twice.evictedOutpoints).toEqual([OUT_1])
    expect(twice.frozenOutpoints).toEqual([])
  })

  it('setFeeRate sets the rate and null disables it', () => {
    const set = foldAction(S(), D({ kind: 'setFeeRate', feeRatePerKb: 25 }))
    expect(set.feeRatePerKb).toBe(25)
    expect(foldAction(set, D({ kind: 'setFeeRate', feeRatePerKb: 7 })).feeRatePerKb).toBe(7)
    expect(foldAction(set, D({ kind: 'setFeeRate', feeRatePerKb: null })).feeRatePerKb).toBeNull()
  })

  it.each(['issue', 'redeem', 'admitIdentity', 'revokeIdentity'] as const)(
    '%s leaves the state unchanged',
    kind => {
      const base = S({
        isPaused: true,
        accessMode: 'allowlist',
        blockedIdentities: [KEY_A],
        allowedIdentities: [KEY_B],
        frozenOutpoints: [{ outpoint: OUT_1, amount: 3, owner: KEY_A }],
        evictedOutpoints: [OUT_2],
        feeRatePerKb: 9,
        lastProcessedHeight: 12,
        lastProcessedOffset: 3,
        lastAdmitSeq: 44
      })
      expect(foldAction(base, D({ kind, identityKey: KEY_A }))).toEqual(base)
    }
  )

  it.each(['bogus', 'constructor', 'toString', '__proto__'])(
    'an unknown kind (%s) is a no-op',
    kind => {
      const base = S({ isPaused: true })
      const next = foldAction(base, D({ kind: kind as AdminDetails['kind'] }))
      expect(next).toEqual(base)
      expect(next).not.toBe(base)
    }
  )

  it.each([
    ['blockIdentity', {}],
    ['unblockIdentity', {}],
    ['allowIdentity', {}],
    ['unallowIdentity', {}],
    ['setAccessMode', {}],
    ['setAccessMode', { mode: 'bogus' }],
    ['freezeOutput', {}],
    ['unfreezeOutput', {}],
    ['reissue', {}],
    ['setFeeRate', {}]
  ] as Array<[AdminDetails['kind'], Partial<AdminDetails>]>)(
    '%s without its field leaves the state unchanged',
    (kind, extra) => {
      const base = S({
        blockedIdentities: [KEY_A],
        allowedIdentities: [KEY_B],
        frozenOutpoints: [{ outpoint: OUT_1, amount: 3, owner: KEY_A }],
        feeRatePerKb: 4
      })
      expect(foldAction(base, { kind, ...extra } as AdminDetails)).toEqual(base)
    }
  )

  it('returns a new state and never mutates its input', () => {
    const base = deepFreeze(
      S({
        blockedIdentities: [KEY_A],
        allowedIdentities: [KEY_B],
        frozenOutpoints: [{ outpoint: OUT_1, amount: 3, owner: KEY_A }],
        evictedOutpoints: [OUT_2],
        feeRatePerKb: 4
      })
    )
    const snapshot = structuredClone(base)
    const details: AdminDetails[] = [
      { kind: 'pause' },
      { kind: 'unpause' },
      { kind: 'blockIdentity', identityKey: KEY_B },
      { kind: 'unblockIdentity', identityKey: KEY_A },
      { kind: 'allowIdentity', identityKey: KEY_A },
      { kind: 'unallowIdentity', identityKey: KEY_B },
      { kind: 'setAccessMode', mode: 'allowlist' },
      { kind: 'freezeOutput', outpoint: OUT_2 },
      { kind: 'unfreezeOutput', outpoint: OUT_1 },
      { kind: 'reissue', outpoint: OUT_1, recipient: KEY_B },
      { kind: 'setFeeRate', feeRatePerKb: null },
      { kind: 'issue' }
    ]
    for (const d of details) {
      const next = foldAction(base, d, { frozenAmount: 1, frozenOwner: KEY_A })
      expect(next).not.toBe(base)
    }
    expect(base).toEqual(snapshot)
  })

  it('folds a sequence into one state', () => {
    const details: AdminDetails[] = [
      { kind: 'setFeeRate', feeRatePerKb: 12 },
      { kind: 'blockIdentity', identityKey: KEY_A },
      { kind: 'freezeOutput', outpoint: OUT_1 },
      { kind: 'pause' },
      { kind: 'reissue', outpoint: OUT_1, recipient: KEY_B },
      { kind: 'setFeeRate', feeRatePerKb: null }
    ]
    const s = details.reduce(
      (state, d) => foldAction(state, d, { frozenAmount: 8, frozenOwner: KEY_A }),
      defaultAssetState(TOKEN, 3)
    )
    expect(s).toEqual({
      ...defaultAssetState(TOKEN),
      isPaused: true,
      blockedIdentities: [KEY_A],
      evictedOutpoints: [OUT_1]
    })
  })
})
