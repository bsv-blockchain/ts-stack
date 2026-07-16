import type { BdkWasmModule } from '../BdkVerifier.js'

declare const createBdkModule: () => Promise<BdkWasmModule>
export default createBdkModule
