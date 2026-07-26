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
    library: 'bsv',
    libraryTarget: 'umd',
    globalObject: 'this'
  },
  resolve: {
    extensions: ['.ts', '.js'] // Resolve both TypeScript and JavaScript files
  },
  mode: 'production',
  devtool: 'source-map',
  optimization: {
    minimize: true
  }
}
