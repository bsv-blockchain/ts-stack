// Mandala admin state fold (spec §3.3): the control state of one token, derived
// by folding its admitted admin actions in order. Pure and deterministic, so the
// overlay can rebuild the state from the journal and reach the same answer.
import type { AdminDetails } from './details.js'

export interface FrozenRef {
  outpoint: string
  amount: number
  owner: string
}

export interface AssetAdminState {
  /** `<64 hex>_0`, the deploy outpoint's display id. */
  tokenId: string
  isPaused: boolean
  accessMode: 'denylist' | 'allowlist'
  blockedIdentities: string[]
  allowedIdentities: string[]
  frozenOutpoints: FrozenRef[]
  evictedOutpoints: string[]
  /** Fee rate in sats per kB, or `null` when fees are off. */
  feeRatePerKb: number | null
  lastProcessedHeight: number
  lastProcessedOffset: number
  lastAdmitSeq: number
}

/** What a fold needs from outside the action: the frozen row's amount and owner. */
export interface FoldContext {
  frozenAmount?: number
  frozenOwner?: string
}

export const defaultAssetState = (
  tokenId: string,
  feeRatePerKb: number | null = null
): AssetAdminState => ({
  tokenId,
  isPaused: false,
  accessMode: 'denylist',
  blockedIdentities: [],
  allowedIdentities: [],
  frozenOutpoints: [],
  evictedOutpoints: [],
  feeRatePerKb,
  lastProcessedHeight: 0,
  lastProcessedOffset: 0,
  lastAdmitSeq: 0
})

const normalized = (value: string): string => value.toLowerCase()

const addUnique = (xs: string[], x: string): string[] => {
  const canonical = normalized(x)
  return xs.some(value => normalized(value) === canonical) ? xs : [...xs, canonical]
}

const remove = (xs: string[], x: string): string[] => {
  const canonical = normalized(x)
  return xs.filter(value => normalized(value) !== canonical)
}

const isFrozen = (frozen: FrozenRef[], outpoint: string): boolean =>
  frozen.some(f => normalized(f.outpoint) === outpoint)

const unfrozen = (frozen: FrozenRef[], outpoint: string): FrozenRef[] =>
  frozen.filter(f => normalized(f.outpoint) !== outpoint)

type Handler = (s: AssetAdminState, d: AdminDetails, ctx: FoldContext) => void

type IdentityList = 'blockedIdentities' | 'allowedIdentities'

const onIdentity =
  (list: IdentityList, update: (xs: string[], x: string) => string[]): Handler =>
  (s, d) => {
    if (typeof d.identityKey === 'string') s[list] = update(s[list], d.identityKey)
  }

// Per-kind handlers mutate the COPY `s` and reassign array fields to NEW
// arrays, never mutating the input state or its arrays. `issue`, `redeem`, the
// registry kinds and unknown kinds have no handler: no control-state change.
const HANDLERS: Readonly<Record<string, Handler>> = {
  pause: s => {
    s.isPaused = true
  },
  unpause: s => {
    s.isPaused = false
  },
  blockIdentity: onIdentity('blockedIdentities', addUnique),
  unblockIdentity: onIdentity('blockedIdentities', remove),
  allowIdentity: onIdentity('allowedIdentities', addUnique),
  unallowIdentity: onIdentity('allowedIdentities', remove),
  setAccessMode: (s, d) => {
    if (d.mode === 'denylist' || d.mode === 'allowlist') s.accessMode = d.mode
  },
  freezeOutput: (s, d, ctx) => {
    if (typeof d.outpoint !== 'string') return
    const outpoint = normalized(d.outpoint)
    if (isFrozen(s.frozenOutpoints, outpoint)) return
    s.frozenOutpoints = [
      ...s.frozenOutpoints,
      {
        outpoint,
        amount: ctx.frozenAmount ?? 0,
        owner: normalized(ctx.frozenOwner ?? '')
      }
    ]
  },
  unfreezeOutput: (s, d) => {
    if (typeof d.outpoint === 'string') {
      s.frozenOutpoints = unfrozen(s.frozenOutpoints, normalized(d.outpoint))
    }
  },
  reissue: (s, d) => {
    if (typeof d.outpoint === 'string') {
      const outpoint = normalized(d.outpoint)
      s.frozenOutpoints = unfrozen(s.frozenOutpoints, outpoint)
      s.evictedOutpoints = addUnique(s.evictedOutpoints, outpoint)
    }
  },
  setFeeRate: (s, d) => {
    if (d.feeRatePerKb !== undefined) s.feeRatePerKb = d.feeRatePerKb
  }
}

/** Applies one admitted admin action to `state`, returning a new state. */
export function foldAction(
  state: AssetAdminState,
  details: AdminDetails,
  ctx: FoldContext = {}
): AssetAdminState {
  const s = { ...state }
  if (Object.hasOwn(HANDLERS, details.kind)) HANDLERS[details.kind](s, details, ctx)
  return s
}
