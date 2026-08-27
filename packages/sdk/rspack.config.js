import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { rspack } from '@rspack/core'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const thirdPartyBanner = `/*! Incorporated third-party material includes MIT code by Fedor Indutny,
Paul Miller, Yours Inc. and other bsv contributors; Apache-2.0 code by the Closure
Library Authors; BSD-2-Clause code by the SJCL authors; and ISC code by Taner Mansur.
See THIRD_PARTY_NOTICES.md for the complete inventory. Keep that notice and
LICENSES/ with this bundle. */`

export default {
  mode: 'production',
  devtool: 'source-map',
  entry: './dist/esm/mod.js',
  output: {
    filename: 'bundle.js',
    path: path.resolve(__dirname, 'dist', 'umd'),
    library: {
      name: 'bsv',
      type: 'umd'
    },
    globalObject: 'this'
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/
      }
    ]
  },
  resolve: {
    extensions: ['.ts', '.js']
  },
  plugins: [
    new rspack.BannerPlugin({ banner: thirdPartyBanner, raw: true, entryOnly: true, stage: 5000 })
  ],
  optimization: {
    minimize: true
  },
  performance: {
    hints: false
  }
}
