import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',   // server (Node.js)
    client: 'src/client.ts', // client (browser + React Native)
    react: 'src/react.tsx',  // React / React Native component + hook
  },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  external: ['@bsv/sdk', 'ws', 'qrcode', 'express', 'http', 'crypto', 'react', 'react/jsx-runtime'],
})
