import { SigmaPermissionModule } from './SigmaPermissionModule.js'
import type { SigmaPermissionModuleOptions } from './types.js'

export { SigmaPermissionModule } from './SigmaPermissionModule.js'
export { parsePoint33, point64 } from './encoding.js'
export { verifyDleq, verifyOr, verifySchnorr } from './sigma.js'
export type {
  SigmaAuthorizationHandler,
  SigmaAuthorizationRequest,
  SigmaKeyDeriver,
  SigmaOperation,
  SigmaPermissionModuleOptions,
  SigmaPrivilegedKeyDeriver
} from './types.js'

export const createSigmaModule = (options: SigmaPermissionModuleOptions): SigmaPermissionModule =>
  new SigmaPermissionModule(options)
