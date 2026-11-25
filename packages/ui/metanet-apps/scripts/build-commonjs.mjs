import { cp, mkdir, readdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const esm = new URL('../dist/esm/', import.meta.url)
const cjs = new URL('../dist/cjs/', import.meta.url)
await mkdir(cjs, { recursive: true })

const entries = await readdir(esm, { recursive: true })
await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  entryPoints: entries.filter(file => file.endsWith('.js')).map(file => `dist/esm/${file}`),
  outbase: 'dist/esm',
  outdir: 'dist/cjs',
  platform: 'node',
  format: 'cjs',
  sourcemap: true
})
await cp(new URL('../dist/types/', import.meta.url), cjs, { recursive: true })
await writeFile(new URL('package.json', cjs), '{"type":"commonjs"}\n')
