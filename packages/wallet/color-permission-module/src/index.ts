import { ColorPermissionModule } from './ColorPermissionModule.js'
import type { ColorPermissionModuleOptions } from './types.js'

export { ColorPermissionModule } from './ColorPermissionModule.js'
export { ColorPlan, COLOR_PLAN_LABEL_PREFIX, COLOR_OPERATIONS } from './ColorPlan.js'
export type { ColorOperation, ColorOperationName, ColorRemittance } from './ColorPlan.js'
export {
  ASSETS_SELECTOR,
  COLOR_KEY_ID,
  ISSUE,
  assetBasket,
  assetTag,
  colorLookupService,
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
