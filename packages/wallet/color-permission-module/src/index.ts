import { ColorPermissionModule } from './ColorPermissionModule.js'
import type { ColorPermissionModuleOptions } from './types.js'

export {
  ColorPermissionModule,
  actionConsent,
  assertPlanAssets,
  assertTransactionOperations,
  assertUnlocks,
  authorityOperation,
  deployOperation,
  readSentToken,
  requiredOperations,
  sighashScopes,
  submissionAssets,
  supplyChange,
  tokenSources,
  transactionConsent,
  transactionTokens,
  tryReadTokenOutput
} from './ColorPermissionModule.js'
export type {
  Custody,
  Holding,
  ManagedInput,
  ReleasedSignature,
  SourceOutput,
  TransactionTokens
} from './ColorPermissionModule.js'
export {
  UnsupportedProfileError,
  assertNoRequiredProfiles,
  readAnyTokenOutput,
  readJsonTokenOutput,
  readTokenOutput
} from './tokenOutputs.js'
export type { JsonOperation, TokenOutput } from './tokenOutputs.js'
export { ColorPlan, COLOR_PLAN_LABEL_PREFIX, COLOR_OPERATIONS } from './ColorPlan.js'
export type { ColorOperation, ColorOperationName, ColorRemittance } from './ColorPlan.js'
export {
  ASSETS_SELECTOR,
  COLOR_KEY_ID,
  ISSUE,
  assetBasket,
  assetTag,
  colorProtocolID,
  colorTopic,
  parseAssetBasket,
  parseBalanceSelector,
  parseColorProtocolID
} from './identifiers.js'
export type { TokenRole } from './identifiers.js'
export type {
  ColorOverlayProvider,
  ColorPermissionModuleOptions,
  ColorTokenAccessHandler
} from './types.js'

export const createColorModule = (options: ColorPermissionModuleOptions): ColorPermissionModule =>
  new ColorPermissionModule(options)
