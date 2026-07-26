import BdkVerifierCore, {
  type BdkVerifierOptions,
  type BdkWasmFactory
} from './src/BdkVerifierCore.js'

export * from './src/BdkVerifierCore.js'
export { mapVerifyFlags, BDK_FLAG_BITS } from './src/flags.js'

interface BdkUmdGlobal {
  createBdkModule?: (options?: {
    locateFile?: (path: string, prefix: string) => string
  }) => ReturnType<BdkWasmFactory>
}

async function globalFactory(): Promise<import('./src/BdkVerifierCore.js').BdkWasmModule> {
  const factory = (globalThis as BdkUmdGlobal).createBdkModule
  if (factory === undefined) {
    throw new Error('Load bdk-core.umd.js before constructing the UMD BdkVerifier')
  }
  return await factory({
    locateFile: (path, prefix) =>
      path.endsWith('.wasm') ? `${prefix}bdk-core.umd.wasm` : `${prefix}${path}`
  })
}

/** Classic-script/UMD verifier using the separately loaded BDK UMD module. */
export class BdkVerifier extends BdkVerifierCore {
  constructor(
    factoryOrOptions: BdkWasmFactory | BdkVerifierOptions = {},
    options: BdkVerifierOptions = {}
  ) {
    if (typeof factoryOrOptions === 'function') {
      super(factoryOrOptions, options)
    } else {
      super(globalFactory, factoryOrOptions)
    }
  }
}
