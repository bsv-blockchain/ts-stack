import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Get __dirname equivalent in ES Modules
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

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
