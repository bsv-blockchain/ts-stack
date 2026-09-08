import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { rspack, SwcJsMinimizerRspackPlugin } from '@rspack/core'

const packageDir = path.dirname(fileURLToPath(import.meta.url))
const thirdPartyBanner = `/*! This bundle includes BDK/bitcoin-sv, libsecp256k1, Emscripten,
musl, LLVM runtime, and Boost material under their respective licenses. Keep
THIRD_PARTY_NOTICES.md and LICENSES/ with the JavaScript and WebAssembly artifacts. */`

export default {
  mode: 'production',
  devtool: 'source-map',
  entry: './dist/umd.js',
  output: {
    filename: 'verifast.cjs',
    path: path.resolve(packageDir, 'dist', 'umd'),
    library: {
      name: 'bsvVerifast',
      type: 'umd'
    },
    globalObject: 'globalThis'
  },
  plugins: [
    new rspack.BannerPlugin({ banner: thirdPartyBanner, raw: true, entryOnly: true, stage: 5000 })
  ],
  optimization: {
    minimize: true,
    minimizer: [
      new SwcJsMinimizerRspackPlugin({
        minimizerOptions: {
          compress: {
            passes: 3,
            pure_getters: true
          },
          mangle: {
            toplevel: true
          },
          format: {
            comments: false
          }
        }
      })
    ]
  },
  performance: { hints: false }
}
