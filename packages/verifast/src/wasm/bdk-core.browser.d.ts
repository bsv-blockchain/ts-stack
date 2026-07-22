import type { BdkWasmModule } from '../BdkVerifierCore.js'
import type { BdkModuleOptions } from './bdk-core.mjs'

declare const createBdkModule: (options?: BdkModuleOptions) => Promise<BdkWasmModule>
export default createBdkModule
