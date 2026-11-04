import type { Transaction, WalletInterface } from '@bsv/sdk'
import { isProfileId } from '@bsv/templates'
import type { OneColorAttributes, StrictCborValue } from '@bsv/templates'
import type { Custody } from './ColorPermissionModule.js'
import { COLOR_OPERATIONS, type ColorOperationName } from './ColorPlan.js'
import { ProfileParamsError } from './errors.js'
import type { JsonValue } from './strictJson.js'
import { assertWellFormedProfileMaps, UnsupportedProfileError } from './tokenOutputs.js'
import type { ColorOverlayProvider } from './types.js'

/** A required-profile descriptor from a deploy's `req`: exactly `{params, version}`. */
export interface ProfileDescriptor {
  version: number
  params: StrictCborValue
}

export interface ProfileAssetContext {
  /** The resolved asset id; `ISSUE` only in `checkDescriptor` for a new deploy. */
  assetId: string
  profileId: string
  /** This handler's own `req` entry. */
  descriptor: ProfileDescriptor
  /** The authenticated deploy `req`, in canonical order. */
  req: ReadonlyMap<string, ProfileDescriptor>
  /** The authenticated deploy transaction, whose id is the asset id's txid. */
  declarationTx: Transaction
  /** The underlying wallet (privileged: not the permissions manager). */
  wallet: WalletInterface
  /** This wallet's identity key. */
  identityKey: string
  originator: string
}

export interface ProfileTxView {
  /**
   * Undefined at createAction (only the args exist then). Set at signAction (final layout, every
   * input has its sourceTransaction, still unsigned for `submissionData`) and at receipt.
   * `inputs` and `outputs` are always populated.
   */
  tx?: Transaction
  assetId: string
  inputs: Array<{
    inputIndex: number
    outpoint: string
    role: 'value' | 'authority'
    amount: bigint
    /** Set iff a managed `p color` input. */
    custody?: Custody
  }>
  outputs: Array<{
    outputIndex: number
    role: 'value' | 'authority'
    amount: bigint
    /** Set iff wallet-owned: token change or a plan's `ownedOutputs`. */
    custody?: Custody
  }>
  /** `plan.profileData[profileId][assetId]` when present. */
  planLeaf?: JsonValue
}

/** One received output of an asset whose required profile defines `admitReceipt`. */
export interface ProfileReceipt {
  assetId: string
  /** The received transaction's id. */
  txid: string
  /** The receipt output's index in `tx`. */
  outputIndex: number
  /** The received transaction, with the source transactions its BEEF carries. */
  tx: Transaction
  /** The internalizeAction `tx` bytes (AtomicBEEF), as the caller supplied them. */
  beef: number[]
}

/**
 * An `admitReceipt` decision: `settled` credits the output as any admitted receipt; `pending`
 * credits it tagged `color_offline` until the host calls `markSettled` for its transaction.
 */
export interface ReceiptAdmission {
  credit: 'settled' | 'pending'
}

export interface RequiredProfileHandler {
  /** The profile URI. */
  readonly id: string
  /** The exact versions supported (0207:95-106). */
  readonly versions: readonly number[]
  /** Validates this descriptor against the full `req` (cross-profile rules). Throws ProfileParamsError. Pure, sync. */
  checkDescriptor: (
    descriptor: ProfileDescriptor,
    req: ReadonlyMap<string, ProfileDescriptor>
  ) => void
  /** The provider for every query and submit of assets requiring this profile. */
  provider?: (assetId: string, descriptor: ProfileDescriptor) => ColorOverlayProvider
  /** Providers asked, in order, for an unknown asset's deploy (`color-admission` of `<txid>.0`). */
  deployProviders?: () => ColorOverlayProvider[]
  /**
   * `plain-nosend`: every token createAction moving this asset must have `options.noSend === true`
   * and must not carry a BRC-177 `p nosend expiry ` label; the module keeps token change inside the
   * transaction (no split), tags that change `color_offline`, and never submits the action: the
   * host does, then calls `markSettled`.
   */
  readonly sendPolicy?: 'plain-nosend'
  /** Operations a holder may declare for this asset through the module; absent means all. */
  readonly operations?: readonly ColorOperationName[]
  /** Checks the caller's plan leaf (undefined when absent), in createAction and again in signAction. Throws ProfileDataError. */
  checkPlanData?: (
    ctx: ProfileAssetContext,
    leaf: JsonValue | undefined,
    view: ProfileTxView
  ) => Promise<void>
  /** The offChainValues bytes for `tm_color_<assetId>`, called in signAction before signing. Must be non-empty. */
  submissionData?: (ctx: ProfileAssetContext, view: ProfileTxView) => Promise<number[]>
  /**
   * Decides every receipt of an asset requiring this profile, after the module's custody, basket,
   * ownership and deploy-conformance checks, in place of the overlay spendability check. A throw
   * credits nothing. The module never parses or stores evidence for it: the hook verifies whatever
   * the host recorded or asks its own overlay.
   */
  admitReceipt?: (ctx: ProfileAssetContext, receipt: ProfileReceipt) => Promise<ReceiptAdmission>
  /** Validates this profile's own `ext` value (undefined when absent). Without it the entry must be absent (ProfileParamsError). */
  checkExt?: (value: StrictCborValue | undefined) => void
}

/** An authenticated asset with its resolved required profiles and routing. Module-internal. */
export interface ResolvedAsset {
  assetId: string
  /** The authenticated deploy transaction; undefined on the no-profiles (0.1.0) path. */
  declarationTx?: Transaction
  /** The deploy's payload attributes; undefined on the 0.1.0 path and for a BRC-161 JSON deploy. */
  attributes?: OneColorAttributes
  /** The deploy's `req`, in canonical order (empty when it declares none). */
  req: ReadonlyMap<string, ProfileDescriptor>
  /** One entry per `req` entry, in canonical `req` order. */
  handlers: ReadonlyArray<{ handler: RequiredProfileHandler; descriptor: ProfileDescriptor }>
  /** The provider for every query and submit of this asset. */
  provider: ColorOverlayProvider
  /** `plain-nosend` when any required profile declares it. */
  sendPolicy?: 'plain-nosend'
  /** The operations every handler that declares `operations` allows; undefined means all. */
  operations?: ReadonlySet<ColorOperationName>
}

const MAX_UINT32 = 0xffffffff
const OPTIONAL_HOOKS = [
  'provider',
  'deployProviders',
  'checkPlanData',
  'submissionData',
  'admitReceipt',
  'checkExt'
] as const

function invalid(id: unknown, reason: string): TypeError {
  return new TypeError(`BRC-207: invalid profile handler ${JSON.stringify(id)}: ${reason}`)
}

function checkHandler(handler: RequiredProfileHandler): void {
  const { id, versions } = handler
  if (typeof id !== 'string' || !isProfileId(id)) {
    throw invalid(id, 'id is not a processing-profile identifier')
  }
  if (
    !Array.isArray(versions) ||
    versions.length === 0 ||
    !versions.every(v => Number.isInteger(v) && v >= 1 && v <= MAX_UINT32)
  ) {
    throw invalid(id, 'versions must be a non-empty list of integers in 1..2^32-1')
  }
  if (typeof handler.checkDescriptor !== 'function') {
    throw invalid(id, 'checkDescriptor must be a function')
  }
  for (const hook of OPTIONAL_HOOKS) {
    if (handler[hook] !== undefined && typeof handler[hook] !== 'function') {
      throw invalid(id, `${hook} must be a function when present`)
    }
  }
  if (handler.sendPolicy !== undefined && handler.sendPolicy !== 'plain-nosend') {
    throw invalid(id, "sendPolicy must be 'plain-nosend' when present")
  }
  const { operations } = handler
  if (
    operations !== undefined &&
    (!Array.isArray(operations) ||
      !operations.every(op => (COLOR_OPERATIONS as readonly string[]).includes(op)))
  ) {
    throw invalid(id, 'operations must list BRC-207 operation names')
  }
}

/**
 * Validates a `profiles` registry and returns a snapshot of it, so later changes to the
 * caller's object have no effect. Throws a TypeError for a registry key that differs from its
 * handler's id, and one starting `BRC-207: invalid profile handler` for any other defect.
 */
export function validateProfileHandlers(
  profiles: Record<string, RequiredProfileHandler> | undefined
): ReadonlyMap<string, RequiredProfileHandler> {
  const registry = new Map<string, RequiredProfileHandler>()
  if (profiles === undefined) return registry
  if (profiles === null || typeof profiles !== 'object' || Array.isArray(profiles)) {
    throw new TypeError('BRC-207: invalid profile handler registry: profiles must be an object')
  }
  for (const [key, handler] of Object.entries(profiles)) {
    if (handler === null || typeof handler !== 'object') {
      throw invalid(key, 'the handler must be an object')
    }
    if (key !== handler.id) throw new TypeError('BRC-207: profiles key must equal its handler id')
    checkHandler(handler)
    registry.set(key, handler)
  }
  return registry
}

/** An asset's required profiles, resolved against the handler registry. */
export interface ResolvedRequirements {
  /** The deploy's `req`, in canonical order (empty when it declares none). */
  req: ReadonlyMap<string, ProfileDescriptor>
  /** One entry per `req` entry, in canonical `req` order. */
  handlers: ReadonlyArray<{ handler: RequiredProfileHandler; descriptor: ProfileDescriptor }>
}

const NO_REQUIREMENTS: ReadonlyMap<string, ProfileDescriptor> = new Map()

/**
 * The support check for a deploy's payload attributes (0207:82-106, contract §2.2 obligation 2).
 * An absent, empty or opaque payload declares an empty `req`; a malformed `req` or `ext` in a
 * valid map fails. Every required id must be registered with its exact version (else
 * UnsupportedProfileError, checked for every entry before any handler code runs, so nothing is
 * partially applied); then each handler's `checkDescriptor` runs, then its own `ext` entry is
 * checked (an entry with no `checkExt` hook fails; `ext` entries of profiles the asset does not
 * require are advisory and ignored). At most one handler may define `submissionData` and at most
 * one `admitReceipt`. Pure and synchronous.
 */
export function resolveRequirements(
  attributes: OneColorAttributes | undefined,
  handlers: ReadonlyMap<string, RequiredProfileHandler>
): ResolvedRequirements {
  if (attributes === undefined || attributes.payload !== 'map') {
    return { req: NO_REQUIREMENTS, handlers: [] }
  }
  assertWellFormedProfileMaps(attributes)
  if (attributes.req.status !== 'valid') return { req: NO_REQUIREMENTS, handlers: [] }
  const req = attributes.req.value

  const resolved: Array<{ handler: RequiredProfileHandler; descriptor: ProfileDescriptor }> = []
  for (const [id, descriptor] of req) {
    const handler = handlers.get(id)
    if (handler === undefined) throw new UnsupportedProfileError()
    if (!handler.versions.includes(descriptor.version)) {
      throw new UnsupportedProfileError(
        'BRC-207: the required processing profile version is unsupported'
      )
    }
    resolved.push({ handler, descriptor })
  }
  for (const { handler, descriptor } of resolved) handler.checkDescriptor(descriptor, req)
  assertOwnExtEntries(resolved, attributes)
  for (const hook of ['submissionData', 'admitReceipt'] as const) {
    if (resolved.filter(({ handler }) => handler[hook] !== undefined).length > 1) {
      throw new ProfileParamsError(`BRC-207: at most one required profile may define ${hook}`)
    }
  }
  return { req, handlers: resolved }
}

/**
 * Checks each required profile's own `ext` entry in `attributes` with its handler's `checkExt`
 * (undefined when the entry is absent). A handler without `checkExt` requires the entry to be
 * absent (ProfileParamsError). Entries of profiles that are not required are advisory and ignored.
 */
export function assertOwnExtEntries(
  handlers: ReadonlyArray<{ handler: RequiredProfileHandler }>,
  attributes: OneColorAttributes
): void {
  const ext =
    attributes.payload === 'map' && attributes.ext.status === 'valid'
      ? attributes.ext.value
      : undefined
  for (const { handler } of handlers) {
    const own = ext?.has(handler.id) === true
    if (handler.checkExt === undefined) {
      if (own) throw new ProfileParamsError(`BRC-207: ${handler.id} defines no own ext entry`)
    } else {
      handler.checkExt(own ? ext!.get(handler.id) : undefined)
    }
  }
}

/**
 * The provider for every query and submit of an asset (contract §2.2 obligation 3): the distinct
 * `provider()` results of its handlers, compared by identity. None gives `fallback`, one gives
 * that provider, and two or more distinct objects fail with ProfileParamsError.
 */
export function routeProvider(
  assetId: string,
  resolved: ResolvedRequirements,
  fallback: ColorOverlayProvider
): ColorOverlayProvider {
  const providers = new Set<ColorOverlayProvider>()
  for (const { handler, descriptor } of resolved.handlers) {
    if (handler.provider !== undefined) providers.add(handler.provider(assetId, descriptor))
  }
  if (providers.size > 1) {
    throw new ProfileParamsError(
      `BRC-207: the required profiles of ${assetId} name more than one provider`
    )
  }
  return providers.size === 1 ? [...providers][0] : fallback
}
