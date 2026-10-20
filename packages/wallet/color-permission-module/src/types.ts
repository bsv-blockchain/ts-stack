import type { LookupAnswer, STEAK, WalletInterface } from '@bsv/sdk'

/**
 * The overlay services this module relies on. The wallet implementer decides which
 * providers are trusted, remote or running inside the wallet; the module only calls this.
 */
export interface ColorOverlayProvider {
  /** BRC-207 `color-spendability`: the queried outputs currently admitted and unspent in `tm_color_<assetId>`. */
  spendability: (assetId: string, outpoints: string[]) => Promise<LookupAnswer>
  /** BRC-207 `color-admission`: the queried outputs ever admitted to `tm_color_<assetId>`, spent or unspent. */
  admission: (assetId: string, outpoints: string[]) => Promise<LookupAnswer>
  /** Submits a transaction to `tm_color_<assetId>` for each asset, returning each topic's admittance. */
  submit: (assetIds: string[], beef: number[]) => Promise<STEAK>
}

/**
 * Approves a token operation described by `message`, a JSON object with a `type` of
 * `color_send`, `color_split`, `color_signature`, `color_access` (a read) or
 * `color_relinquish`. Resolves true only when approved.
 *
 * The module asks on every operation and keeps no grants. The host decides whether an
 * existing grant covers a request, how long grants last, and whether to prompt the user.
 */
export type ColorTokenAccessHandler = (app: string, message: string) => Promise<boolean>

export interface ColorPermissionModuleOptions {
  /**
   * The wallet that the permissions manager wraps. The module derives keys, signs and
   * reads its own baskets through it, so it must not be the permissions manager itself.
   */
  wallet: WalletInterface
  provider: ColorOverlayProvider
  requestTokenAccess: ColorTokenAccessHandler
}
