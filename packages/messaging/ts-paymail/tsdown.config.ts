import { defineConfig } from 'tsdown'

export default defineConfig({
  clean: true,
  dts: true,
  entry: [
    'mod.ts',
    'mod.browser.ts',
    'src/capability/*.ts',
    'src/errors/*.ts',
    'src/paymailClient/*.ts',
    'src/paymailClient/resolver/*.ts',
    'src/paymailRouter/*.ts',
    'src/paymailRouter/paymailRoutes/*.ts'
  ],
  format: ['cjs', 'esm'],
  outDir: 'dist',
  platform: 'neutral',
  sourcemap: true,
  tsconfig: 'tsconfig.base.json',
  unbundle: true
})
