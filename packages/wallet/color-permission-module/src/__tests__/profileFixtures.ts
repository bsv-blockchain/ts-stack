import { LockingScript, Transaction } from '@bsv/sdk'
import { toArray } from '@bsv/sdk/primitives/utils'
import { encodeStrictCbor, type StrictCborValue } from '@bsv/templates'
import { ColorPermissionModule } from '../ColorPermissionModule.js'
import { ProfileParamsError } from '../errors.js'
import type {
  ProfileAssetContext,
  ProfileReceipt,
  ReceiptAdmission,
  RequiredProfileHandler,
  ResolvedAsset
} from '../profiles.js'
import type { TokenOutput } from '../tokenOutputs.js'
import type { ColorModuleStore, ColorOverlayProvider } from '../types.js'

/** A Map-backed `ColorModuleStore` that logs every `set` key, in order. */
export class FakeStore implements ColorModuleStore {
  readonly entries = new Map<string, string>()
  readonly writes: string[] = []

  get = async (key: string): Promise<string | undefined> => this.entries.get(key)

  set = async (key: string, value: string): Promise<void> => {
    this.writes.push(key)
    this.entries.set(key, value)
  }

  delete = async (key: string): Promise<void> => {
    this.entries.delete(key)
  }

  keys = async (prefix: string): Promise<string[]> =>
    [...this.entries.keys()].filter(key => key.startsWith(prefix)).sort()

  /** Simulates store loss. */
  clear(): void {
    this.entries.clear()
  }
}

const isRevision = (value: StrictCborValue): boolean =>
  (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
  (typeof value === 'bigint' && value >= 0n)

/**
 * The A.141a revision profile (0207 Appendix A.141a): `urn:example:color:revision` v1, null
 * params, and an optional `ext` entry `{revision: uint}`.
 */
export function exampleProfile(): RequiredProfileHandler {
  return {
    id: 'urn:example:color:revision',
    versions: [1],
    checkDescriptor: descriptor => {
      if (descriptor.params !== null) {
        throw new ProfileParamsError('BRC-207: the revision profile takes null params')
      }
    },
    checkExt: value => {
      if (value === undefined) return
      if (
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        value instanceof Uint8Array ||
        Object.keys(value).length !== 1 ||
        !Object.prototype.hasOwnProperty.call(value, 'revision') ||
        !isRevision((value as Record<string, StrictCborValue>).revision)
      ) {
        throw new ProfileParamsError('BRC-207: the revision ext entry must be {revision: uint}')
      }
    }
  }
}

/** The A.141a required-profile deploy locking scripts (0207:9376-9383), verbatim. */
export const A141A = {
  U: '00596d33a163726571a1781975726e3a6578616d706c653a636f6c6f723a756e6b6e6f776ea266706172616d73f66776657273696f6e017576a914fc63218003683dc3305d0644a52f73eb0802e5c188ac',
  V: '00596d34a163726571a1781a75726e3a6578616d706c653a636f6c6f723a7265766973696f6ea266706172616d73f66776657273696f6e027576a914fc63218003683dc3305d0644a52f73eb0802e5c188ac',
  C: '00596d4c60a263657874a1781a75726e3a6578616d706c653a636f6c6f723a7265766973696f6ea1687265766973696f6e0063726571a1781a75726e3a6578616d706c653a636f6c6f723a7265766973696f6ea266706172616d73f66776657273696f6e0175ab76a914fc63218003683dc3305d0644a52f73eb0802e5c188ac',
  D: '00596d3fa263657874a1781975726e3a6578616d706c653a646973706c61793a776f726473a2636f6e65646974656d646d616e79656974656d736373796d644954454d7576a914fc63218003683dc3305d0644a52f73eb0802e5c188ac',
  M: '00596d06a163726571f67576a914fc63218003683dc3305d0644a52f73eb0802e5c188ac',
  L: '0063036f726451126170706c69636174696f6e2f6273762d3230004ca37b2270223a226273762d3230222c226f70223a226465706c6f792b6d696e74222c22616d74223a2239222c22636f6c6f725061796c6f6164223a22613136333732363537316131373831393735373236653361363537383631366437303663363533613633366636633666373233613735366536623665366637373665613236363730363137323631366437336636363737363635373237333639366636653031227d6876a914fc63218003683dc3305d0644a52f73eb0802e5c188ac',
  X: '00596d4c8da263657874a1781a75726e3a6578616d706c653a636f6c6f723a7265766973696f6ea1687265766973696f6e0063726571a2781975726e3a6578616d706c653a636f6c6f723a756e6b6e6f776ea266706172616d73f66776657273696f6e01781a75726e3a6578616d706c653a636f6c6f723a7265766973696f6ea266706172616d73f66776657273696f6e0175ab76a914fc63218003683dc3305d0644a52f73eb0802e5c188ac',
  N: '00596d36a163726571a1781c75726e3a6578616d706c653a636f6c6f723a6e6f2d6f7665726c6179a266706172616d73f66776657273696f6e017576a914fc63218003683dc3305d0644a52f73eb0802e5c188ac'
} as const

/** A one-output transaction (1000 sats) carrying `hex` as output 0, and its asset id `<txid>_0`. */
export function fixtureDeploy(hex: string): { tx: Transaction; assetId: string } {
  const tx = new Transaction()
  tx.addOutput({ lockingScript: LockingScript.fromHex(hex), satoshis: 1000 })
  return { tx, assetId: `${tx.id('hex')}_0` }
}

/** Exposes the module's protected asset-resolution seams to tests. */
export class TestModule extends ColorPermissionModule {
  async resolveAssetForTest(assetId: string): Promise<ResolvedAsset> {
    return await this.resolveAsset(assetId)
  }

  async providerForTest(assetId: string): Promise<ColorOverlayProvider> {
    return await this.providerFor(assetId)
  }

  async assertConformingTokensForTest(tokens: Iterable<TokenOutput>): Promise<void> {
    await this.assertConformingTokens(tokens)
  }

  async candidatesForTest(
    assetId: string,
    role: 'value' | 'authority',
    originator: string
  ): Promise<Array<{ outpoint: string; amount: bigint }>> {
    return await this.candidates(assetId, role, originator)
  }
}

/** The issuer-like test profile's id. */
export const ISSUER_LIKE_ID = 'urn:example:color:issuer'

/** The deploy payload of an issuer-like asset: the issuer-like profile v1 with params `{identityKey: K}`. */
export function issuerLikePayload(K: string): number[] {
  return encodeStrictCbor({ req: { [ISSUER_LIKE_ID]: { params: { identityKey: K }, version: 1 } } })
}

/**
 * An issuer-like required profile, shaped like the Mandala issuer-v1 profile: plain-noSend
 * transfers only, routed to `provider` when given, submission data from the plan leaf, and an
 * `admitReceipt` that answers `admit` (default: settled). It never looks at any other profile.
 */
export function issuerLikeProfile(options: {
  K: string
  provider?: ColorOverlayProvider
  admit?: (ctx: ProfileAssetContext, receipt: ProfileReceipt) => Promise<ReceiptAdmission>
}): RequiredProfileHandler {
  const { K, provider } = options
  return {
    id: ISSUER_LIKE_ID,
    versions: [1],
    sendPolicy: 'plain-nosend',
    operations: ['transfer'],
    ...(provider === undefined ? {} : { provider: () => provider }),
    checkDescriptor: descriptor => {
      const own = descriptor.params as Record<string, StrictCborValue> | null
      if (own === null || typeof own !== 'object' || own.identityKey !== K) {
        throw new ProfileParamsError('BRC-207: the issuer profile names another identity')
      }
    },
    checkPlanData: async () => {},
    submissionData: async (_ctx, view) => toArray(JSON.stringify(view.planLeaf ?? null), 'utf8'),
    admitReceipt: options.admit ?? (async () => ({ credit: 'settled' }))
  }
}
