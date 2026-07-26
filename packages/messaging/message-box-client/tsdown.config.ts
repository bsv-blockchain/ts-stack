import { defineConfig } from 'tsdown'

export default defineConfig({
  clean: true,
  dts: true,
  entry: ['mod.ts'],
  format: ['cjs', 'esm'],
  outDir: 'dist',
  platform: 'browser',
  sourcemap: true,
  tsconfig: 'tsconfig.base.json',
  unbundle: true
})
