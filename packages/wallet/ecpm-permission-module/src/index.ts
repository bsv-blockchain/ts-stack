import { EcpmPermissionModule } from './EcpmPermissionModule.js'
import type { EcpmPermissionModuleOptions } from './types.js'

export { EcpmPermissionModule } from './EcpmPermissionModule.js'
export type {
  EcpmAuthorizationHandler,
  EcpmAuthorizationRequest,
  EcpmKeyDeriver,
  EcpmOperation,
  EcpmPermissionModuleOptions,
  EcpmPrivilegedKeyDeriver
} from './types.js'

export const createEcpmModule = (options: EcpmPermissionModuleOptions): EcpmPermissionModule =>
  new EcpmPermissionModule(options)
