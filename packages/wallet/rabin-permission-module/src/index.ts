import { RabinPermissionModule } from './RabinPermissionModule.js'
import type { RabinPermissionModuleOptions } from './types.js'

export { RabinPermissionModule } from './RabinPermissionModule.js'
export {
  decodeFields,
  decodeKeyResult,
  decodeSignResult,
  encodeFields,
  scriptNum,
  scriptNumToBigInt
} from './encoding.js'
export { PADDING_LIMIT, digestValue, verify } from './rabin.js'
export type {
  RabinAuthorizationHandler,
  RabinAuthorizationRequest,
  RabinBits,
  RabinCounterparty,
  RabinKeyDeriver,
  RabinOperation,
  RabinPermissionModuleOptions,
  RabinPrivilegedKeyDeriver
} from './types.js'

export const createRabinModule = (options: RabinPermissionModuleOptions): RabinPermissionModule =>
  new RabinPermissionModule(options)
