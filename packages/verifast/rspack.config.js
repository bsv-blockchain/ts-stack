import { fileURLToPath } from 'node:url'
import path from 'node:path'

const packageDir = path.dirname(fileURLToPath(import.meta.url))

export default {
  mode: 'production',
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
  optimization: { minimize: true },
  performance: { hints: false }
}
