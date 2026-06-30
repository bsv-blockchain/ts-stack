import { MandalaActionDetails } from '@bsv/templates'

export interface FrozenRef { outpoint: string, amount: number, owner: string }

export interface AssetAdminState {
  assetId: string
  issuerIdentityKey: string
  isPaused: boolean
  accessMode: 'denylist' | 'allowlist'
  blockedIdentities: string[]
  allowedIdentities: string[]
  frozenOutpoints: FrozenRef[]
  evictedOutpoints: string[]
  lastProcessedHeight: number
  lastProcessedOffset: number
  lastAdmitSeq: number
}

export interface FoldContext { frozenAmount?: number, frozenOwner?: string, issuer?: string }

export const defaultAssetState = (assetId: string): AssetAdminState => ({
  assetId,
  issuerIdentityKey: '',
  isPaused: false,
  accessMode: 'denylist',
  blockedIdentities: [],
  allowedIdentities: [],
  frozenOutpoints: [],
  evictedOutpoints: [],
  lastProcessedHeight: 0,
  lastProcessedOffset: 0,
  lastAdmitSeq: 0
})

const addUnique = (xs: string[], x: string): string[] => xs.includes(x) ? xs : [...xs, x]
const remove = (xs: string[], x: string): string[] => xs.filter(v => v !== x)

export function foldAction (
  state: AssetAdminState,
  details: MandalaActionDetails,
  ctx: FoldContext = {}
): AssetAdminState {
  const s = { ...state }
  switch (details.kind) {
    case 'register':
      if (typeof ctx.issuer === 'string') s.issuerIdentityKey = ctx.issuer
      return s
    case 'pause': s.isPaused = true; return s
    case 'unpause': s.isPaused = false; return s
    case 'blockIdentity':
      if (typeof details.identityKey === 'string') s.blockedIdentities = addUnique(s.blockedIdentities, details.identityKey)
      return s
    case 'unblockIdentity':
      if (typeof details.identityKey === 'string') s.blockedIdentities = remove(s.blockedIdentities, details.identityKey)
      return s
    case 'allowIdentity':
      if (typeof details.identityKey === 'string') s.allowedIdentities = addUnique(s.allowedIdentities, details.identityKey)
      return s
    case 'unallowIdentity':
      if (typeof details.identityKey === 'string') s.allowedIdentities = remove(s.allowedIdentities, details.identityKey)
      return s
    case 'setAccessMode':
      if (details.mode === 'denylist' || details.mode === 'allowlist') s.accessMode = details.mode
      return s
    case 'freezeOutput':
      if (typeof details.outpoint === 'string') {
        s.frozenOutpoints = [
          ...s.frozenOutpoints.filter(f => f.outpoint !== details.outpoint),
          { outpoint: details.outpoint, amount: ctx.frozenAmount ?? 0, owner: ctx.frozenOwner ?? '' }
        ]
      }
      return s
    case 'unfreezeOutput':
      if (typeof details.outpoint === 'string') s.frozenOutpoints = s.frozenOutpoints.filter(f => f.outpoint !== details.outpoint)
      return s
    case 'reissue':
      if (typeof details.outpoint === 'string') {
        s.frozenOutpoints = s.frozenOutpoints.filter(f => f.outpoint !== details.outpoint)
        s.evictedOutpoints = addUnique(s.evictedOutpoints, details.outpoint)
      }
      return s
    default:
      return s // issue/redeem/recover and unknown kinds: no control-state change
  }
}
