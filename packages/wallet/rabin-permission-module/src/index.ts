export {
  RabinPermissionModule,
  decodeRabinKey,
  decodeRabinSignature
} from './RabinPermissionModule.js'
export { verifyRabinSignature } from './rabin.js'
export { RABIN_PADDING_LIMIT } from './scriptNumber.js'
export type {
  RabinAuthorizationHandler,
  RabinAuthorizationRequest,
  RabinKeyDeriver,
  RabinModulusBits,
  RabinOperation,
  RabinPermissionModuleOptions,
  RabinPrivilegedKeyDeriver
} from './types.js'
import { RabinPermissionModule } from './RabinPermissionModule.js'
import type { RabinPermissionModuleOptions } from './types.js'

export const createRabinModule = (options: RabinPermissionModuleOptions): RabinPermissionModule =>
  new RabinPermissionModule(options)
