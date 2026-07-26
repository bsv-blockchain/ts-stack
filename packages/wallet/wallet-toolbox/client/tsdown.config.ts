import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: '../src/index.client.ts',
  format: ['cjs', 'esm'],
  outDir: 'out',
  platform: 'browser',
  target: 'es2022',
  fixedExtension: true,
  dts: true,
  sourcemap: true,
  clean: true,
  tsconfig: '../tsconfig.client.json',
  deps: {
    neverBundle: true,
    onlyImport: ['@bsv/sdk', 'hash-wasm', 'idb']
  },
  checks: {
    legacyCjs: false
  },
  failOnWarn: true
})
