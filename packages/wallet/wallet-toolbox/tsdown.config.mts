import { defineConfig } from 'tsdown'

// ESM build, one module per source file so the deep-import paths that mirror
// out/src are available to ESM consumers as well. The CommonJS build stays the
// `tsc --build` tree under out/src.
export default defineConfig({
  // Every module the CommonJS tree publishes, with tsconfig.all.json's test exclusions.
  entry: ['src/**/*.ts', '!src/**/__tests/**', '!src/**/__tests__/**', '!src/**/*.test.ts'],
  unbundle: true,
  root: '.',
  format: ['esm'],
  outDir: 'out/esm',
  platform: 'node',
  target: 'es2022',
  fixedExtension: true,
  dts: true,
  sourcemap: true,
  clean: true,
  shims: true,
  tsconfig: 'tsconfig.esm.json',
  deps: {
    neverBundle: true
  },
  failOnWarn: true
})
