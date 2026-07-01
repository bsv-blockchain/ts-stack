import { defaultAssetState, foldAction, AssetAdminState } from '../AssetStateReducer.js'
import { MandalaActionDetails } from '@bsv/templates'

const S = (over: Partial<AssetAdminState> = {}): AssetAdminState => ({ ...defaultAssetState('x.0'), ...over })
const d = (o: Partial<MandalaActionDetails>): MandalaActionDetails => ({ kind: 'pause', assetId: 'x.0', ...o } as MandalaActionDetails)

describe('foldAction', () => {
  it('register sets issuerIdentityKey from ctx', () => {
    const s = foldAction(S(), d({ kind: 'register' }), { issuer: '02issuer' })
    expect(s.issuerIdentityKey).toBe('02issuer')
  })
  it('pause/unpause toggle isPaused', () => {
    expect(foldAction(S(), d({ kind: 'pause' })).isPaused).toBe(true)
    expect(foldAction(S({ isPaused: true }), d({ kind: 'unpause' })).isPaused).toBe(false)
  })
  it('block/unblock identity is idempotent on the denylist', () => {
    let s = foldAction(S(), d({ kind: 'blockIdentity', identityKey: '02aa' }))
    s = foldAction(s, d({ kind: 'blockIdentity', identityKey: '02aa' })) // dup
    expect(s.blockedIdentities).toEqual(['02aa'])
    s = foldAction(s, d({ kind: 'unblockIdentity', identityKey: '02aa' }))
    expect(s.blockedIdentities).toEqual([])
  })
  it('allow/unallow identity targets the allowlist only', () => {
    const s = foldAction(S(), d({ kind: 'allowIdentity', identityKey: '02bb' }))
    expect(s.allowedIdentities).toEqual(['02bb'])
    expect(s.blockedIdentities).toEqual([])
  })
  it('setAccessMode switches mode', () => {
    expect(foldAction(S(), d({ kind: 'setAccessMode', mode: 'allowlist' })).accessMode).toBe('allowlist')
  })
  it('freezeOutput records {outpoint, amount, owner} from ctx; unfreeze removes by outpoint', () => {
    let s = foldAction(S(), d({ kind: 'freezeOutput', outpoint: 'tt.2' }), { frozenAmount: 30, frozenOwner: '02own' })
    expect(s.frozenOutpoints).toEqual([{ outpoint: 'tt.2', amount: 30, owner: '02own' }])
    s = foldAction(s, d({ kind: 'unfreezeOutput', outpoint: 'tt.2' }))
    expect(s.frozenOutpoints).toEqual([])
  })
  it('reissue moves outpoint from frozen to evicted', () => {
    const frozen = S({ frozenOutpoints: [{ outpoint: 'tt.2', amount: 30, owner: '02own' }] })
    const s = foldAction(frozen, d({ kind: 'reissue', outpoint: 'tt.2', amount: 30, recipient: '02new' }))
    expect(s.frozenOutpoints).toEqual([])
    expect(s.evictedOutpoints).toEqual(['tt.2'])
  })
  it('issue/redeem do not change control state', () => {
    const base = S({ isPaused: true })
    for (const kind of ['issue', 'redeem'] as const) {
      expect(foldAction(base, d({ kind, amount: 1 }))).toEqual(base)
    }
  })
  it('unknown kind is a no-op', () => {
    const base = S()
    expect(foldAction(base, d({ kind: 'bogus' as any }))).toEqual(base)
  })
})
