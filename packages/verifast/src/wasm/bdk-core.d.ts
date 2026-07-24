import type { BdkWasmModule } from '../BdkVerifierCore.js'

export interface BdkModuleOptions {
  locateFile?: (path: string, prefix: string) => string
  wasmBinary?: Uint8Array
}

declare const createBdkModule: (options?: BdkModuleOptions) => Promise<BdkWasmModule>
export default createBdkModule
