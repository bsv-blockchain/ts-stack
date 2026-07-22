import createBdkModule from './wasm/bdk-core.browser.mjs'
import BdkVerifierCore, {
  type BdkVerifierOptions,
  type BdkWasmFactory
} from './BdkVerifierCore.js'

export * from './BdkVerifierCore.js'

const createBundledModule: BdkWasmFactory = async () => await createBdkModule({
  locateFile: (path: string, prefix: string): string =>
    path.endsWith('.wasm') ? `${prefix}bdk-core.wasm` : `${prefix}${path}`
})

/** Browser/worker BDK verifier using glue with no Node imports. */
export default class BdkVerifier extends BdkVerifierCore {
  constructor (factoryOrOptions: BdkWasmFactory | BdkVerifierOptions = {}, options: BdkVerifierOptions = {}) {
    if (typeof factoryOrOptions === 'function') {
      super(factoryOrOptions, options)
    } else {
      super(createBundledModule, factoryOrOptions)
    }
  }
}
