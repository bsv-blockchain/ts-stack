import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'

const source = new URL('../src/wasm/', import.meta.url)
const destination = new URL('../dist/src/wasm/', import.meta.url)

await mkdir(destination, { recursive: true })
for (const file of [
  'bdk-core.mjs',
  'bdk-core.wasm',
  'bdk-core.browser.mjs',
  'bdk-core.umd.js',
  'bdk-core.umd.wasm'
]) {
  await cp(new URL(file, source), new URL(file, destination))
}

// The upstream Emscripten browser glue names a non-existent
// bdk-core.browser.wasm fallback. locateFile handles runtime loading, but
// production bundlers still resolve that static URL. Point the published glue
// at the shipped shared browser artifact without modifying the pinned source.
const browserLoader = new URL('bdk-core.browser.mjs', destination)
const glue = await readFile(browserLoader, 'utf8')
const bundledGlue = glue.replaceAll('bdk-core.browser.wasm', 'bdk-core.wasm')
if (bundledGlue === glue) {
  throw new Error('Expected the Emscripten browser-WASM fallback reference')
}
await writeFile(browserLoader, bundledGlue)
