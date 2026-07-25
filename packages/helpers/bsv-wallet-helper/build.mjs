import { build } from 'esbuild'
import { rm } from 'node:fs/promises'

await rm(new URL('./dist', import.meta.url), { recursive: true, force: true })

const shared = {
  bundle: true,
  entryPoints: ['src/index.ts'],
  logLevel: 'info',
  packages: 'external',
  platform: 'node',
  target: 'es2020',
}

await Promise.all([
  build({
    ...shared,
    format: 'cjs',
    outfile: 'dist/index.js',
  }),
  build({
    ...shared,
    format: 'esm',
    outfile: 'dist/index.mjs',
  }),
])
