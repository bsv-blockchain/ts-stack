import { stat } from 'node:fs/promises'

const MAX_CLASSIC_BROWSER_BYTES = 300_000
const artifacts = [
  new URL('../dist/umd/verifast.js', import.meta.url),
  new URL('../dist/src/wasm/bdk-core.umd.js', import.meta.url),
  new URL('../dist/src/wasm/bdk-core.umd.wasm', import.meta.url)
]

const sizes = await Promise.all(artifacts.map(async artifact => (await stat(artifact)).size))
const total = sizes.reduce((sum, size) => sum + size, 0)

if (total > MAX_CLASSIC_BROWSER_BYTES) {
  throw new Error(
    `Classic browser payload is ${total} bytes; limit is ${MAX_CLASSIC_BROWSER_BYTES} bytes`
  )
}

console.log(`Classic browser payload: ${total} / ${MAX_CLASSIC_BROWSER_BYTES} bytes`)
