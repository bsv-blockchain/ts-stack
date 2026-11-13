import { defineConfig } from 'tsdown'
import { fileURLToPath } from 'node:url'

const sdkPeerExports = fileURLToPath(new URL('./sdk-peer-exports.ts', import.meta.url))

export default defineConfig({
  entry: '../src/index.mobile.ts',
  format: ['cjs', 'esm'],
  outDir: 'out',
  platform: 'neutral',
  target: 'es2022',
  fixedExtension: true,
  dts: true,
  sourcemap: true,
  // Match the browser artifact's conservative compaction: retain public
  // function/class names, properties, debugger statements, licenses and maps.
  outputOptions(options, _format, { cjsDts }) {
    if (cjsDts) return options
    return {
      ...options,
      comments: { legal: true, annotation: true, jsdoc: false },
      codeSplitting: {
        groups: [
          { name: 'structured-json', test: id => id.endsWith('/storage/portable/Brc38StructuredJson.ts') },
          { name: 'private-idb-stage', test: id => id.endsWith('/storage/portable/Brc38PrivateIdbStage.ts') },
          { name: 'idb-import-journal', test: id => id.endsWith('/storage/portable/Brc38IdbImportJournal.ts') },
          { name: 'wallet-permissions', test: id => id.endsWith('/src/WalletPermissionsManager.ts') },
          { name: 'wallet-manager', test: id => id.endsWith('/src/CWIStyleWalletManager.ts') }
        ]
      }
    }
  },
  minify: {
    compress: { keepNames: { function: true, class: true }, dropDebugger: false },
    mangle: { keepNames: true, reserved: ['exports', 'module'] },
    codegen: { removeWhitespace: false, legalComments: 'inline' }
  },
  plugins: [
    {
      name: 'external-sdk-category-imports',
      resolveId: {
        order: 'pre',
        handler(id, importer) {
          if (importer === sdkPeerExports && (id === '@bsv/sdk' || id.startsWith('@bsv/sdk/'))) {
            // The SDK marks its other modules side-effect-free. Keep the
            // primitive barrel eager to retain its marked curve-entry setup.
            return { id, external: true, moduleSideEffects: id === '@bsv/sdk/primitives' }
          }
          if (id === '@bsv/sdk' && importer !== sdkPeerExports && !/\.d\.[cm]?ts$/.test(importer ?? '')) {
            return sdkPeerExports
          }
        }
      }
    }
  ],
  clean: true,
  tsconfig: '../tsconfig.mobile.json',
  deps: {
    neverBundle: true,
    // Keep only the used Argon2id fallback and its dependency closure. Metro
    // otherwise retains every export of the external Argon2/BLAKE2 modules.
    alwaysBundle: [/^@noble\/hashes(?:\/|$)/],
    onlyBundle: ['@noble/hashes'],
    onlyImport: ['@bsv/sdk', '@noble/hashes', 'hash-wasm', 'idb']
  },
  checks: {
    legacyCjs: false
  },
  failOnWarn: true
})
