import { fileURLToPath } from 'node:url'
import path from 'node:path'
import webpack from 'webpack'

// Get __dirname equivalent in ES Modules
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export default {
  entry: './dist/mod.js',
  output: {
    filename: 'bundle.js',
    path: path.resolve(__dirname, 'dist', 'umd'),
    library: 'did-client',
    libraryTarget: 'umd',
    globalObject: 'this'
  },
  resolve: {
    extensions: ['.ts', '.js'] // Resolve both TypeScript and JavaScript files
  },
  mode: 'production',
  target: 'web',
  devtool: 'source-map',
  plugins: [
    new webpack.DefinePlugin({
      'typeof require': JSON.stringify('undefined')
    })
  ],
  optimization: {
    minimize: true
  },
  performance: {
    hints: false
  }
}
