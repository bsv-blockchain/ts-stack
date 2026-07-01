import { MandalaActionDetails, MandalaActionKind } from '@bsv/templates'

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

type Handler = (s: AssetAdminState, d: MandalaActionDetails, ctx: FoldContext) => void

// Per-kind handlers mutate the COPY `s` and reassign array fields to NEW arrays,
// never mutating the input state or its arrays. issue/redeem and unknown
// kinds have no handler: no control-state change.
const HANDLERS: Partial<Record<MandalaActionKind, Handler>> = {
  register: (s, _d, ctx) => { if (typeof ctx.issuer === 'string') s.issuerIdentityKey = ctx.issuer },
  pause: (s) => { s.isPaused = true },
  unpause: (s) => { s.isPaused = false },
  blockIdentity: (s, d) => { if (typeof d.identityKey === 'string') s.blockedIdentities = addUnique(s.blockedIdentities, d.identityKey) },
  unblockIdentity: (s, d) => { if (typeof d.identityKey === 'string') s.blockedIdentities = remove(s.blockedIdentities, d.identityKey) },
  allowIdentity: (s, d) => { if (typeof d.identityKey === 'string') s.allowedIdentities = addUnique(s.allowedIdentities, d.identityKey) },
  unallowIdentity: (s, d) => { if (typeof d.identityKey === 'string') s.allowedIdentities = remove(s.allowedIdentities, d.identityKey) },
  setAccessMode: (s, d) => { if (d.mode === 'denylist' || d.mode === 'allowlist') s.accessMode = d.mode },
  freezeOutput: (s, d, ctx) => {
    if (typeof d.outpoint === 'string') {
      s.frozenOutpoints = [
        ...s.frozenOutpoints.filter(f => f.outpoint !== d.outpoint),
        { outpoint: d.outpoint, amount: ctx.frozenAmount ?? 0, owner: ctx.frozenOwner ?? '' }
      ]
    }
  },
  unfreezeOutput: (s, d) => { if (typeof d.outpoint === 'string') s.frozenOutpoints = s.frozenOutpoints.filter(f => f.outpoint !== d.outpoint) },
  reissue: (s, d) => {
    if (typeof d.outpoint === 'string') {
      s.frozenOutpoints = s.frozenOutpoints.filter(f => f.outpoint !== d.outpoint)
      s.evictedOutpoints = addUnique(s.evictedOutpoints, d.outpoint)
    }
  }
}

export function foldAction (
  state: AssetAdminState,
  details: MandalaActionDetails,
  ctx: FoldContext = {}
): AssetAdminState {
  const s = { ...state }
  HANDLERS[details.kind]?.(s, details, ctx)
  return s
}
