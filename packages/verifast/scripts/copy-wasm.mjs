import { cp, mkdir } from 'node:fs/promises'

const source = new URL('../src/wasm/', import.meta.url)
const destination = new URL('../dist/src/wasm/', import.meta.url)

await mkdir(destination, { recursive: true })
for (const file of ['bdk-core.mjs', 'bdk-core.wasm']) {
  await cp(new URL(file, source), new URL(file, destination))
}
