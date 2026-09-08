import { fileURLToPath } from 'node:url'
import path from 'node:path'
import webpack from 'webpack'

// Get __dirname equivalent in ES Modules
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const thirdPartyBanner = `/*! Incorporated third-party material includes MIT code by Fedor Indutny,
Paul Miller, Yours Inc. and other bsv contributors; Apache-2.0 code by the Closure
Library Authors; BSD-2-Clause code by the SJCL authors; and ISC code by Taner Mansur.
See THIRD_PARTY_NOTICES.md for the complete inventory. Keep that notice and
LICENSES/ with this bundle. */`

export default {
  entry: './dist/mod.js',
  output: {
    filename: 'bundle.js', // Output single bundled file
    path: path.resolve(__dirname, 'dist', 'umd'), // Output directory
    library: 'messageBoxClient',
    libraryTarget: 'umd',
    globalObject: 'this'
  },
  resolve: {
    extensions: ['.ts', '.js'] // Resolve both TypeScript and JavaScript files
  },
  mode: 'production',
  devtool: 'source-map',
  plugins: [
    new webpack.BannerPlugin({ banner: thirdPartyBanner, raw: true, entryOnly: true, stage: 5000 })
  ],
  module: {
    rules: [
      {
        test: /[/\\]transaction[/\\]http[/\\](?:DefaultHttpClient|BinaryFetchClient)\.js$/,
        use: path.resolve(__dirname, 'scripts', 'remove-node-https-fallback.cjs')
      },
      {
        test: /\.ts$/, // Use ts-loader to transpile TypeScript files
        use: 'ts-loader',
        exclude: /node_modules/
      }
    ]
  },
  optimization: {
    minimize: true
  },
  performance: {
    hints: false
  }
}
