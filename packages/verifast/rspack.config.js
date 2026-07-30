import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { SwcJsMinimizerRspackPlugin } from '@rspack/core'

const packageDir = path.dirname(fileURLToPath(import.meta.url))

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
