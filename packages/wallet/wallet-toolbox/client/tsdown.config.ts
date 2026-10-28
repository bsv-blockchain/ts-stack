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
  // Keep documentation in source/declarations/maps without duplicating it in
  // shipped JavaScript. Retain licenses and downstream tree-shaking annotations.
  outputOptions: {
    comments: { legal: true, annotation: true, jsdoc: false }
  },
  // Preserve public names/properties and diagnostics while compacting the
  // shipped implementation. Vite preserves ES-library whitespace.
  minify: {
    compress: { keepNames: { function: true, class: true }, dropDebugger: false },
    mangle: { keepNames: true, reserved: ['exports', 'module'] },
    codegen: { removeWhitespace: false, legalComments: 'inline' }
  },
  clean: true,
  tsconfig: '../tsconfig.client.json',
  deps: {
    neverBundle: true,
    onlyImport: ['@bsv/sdk', '@noble/hashes', 'hash-wasm', 'idb']
  },
  checks: {
    legacyCjs: false
  },
  failOnWarn: true
})
