import { fileURLToPath } from 'url'
import path from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export default {
  mode: 'production',
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
  optimization: {
    minimize: true
  },
  performance: {
    hints: false
  }
}
