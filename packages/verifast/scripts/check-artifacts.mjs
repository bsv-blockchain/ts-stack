import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const expected = new Map([
  ['bdk-core.mjs', 'ed62862f3f35a8c010b96bc8a8f24397d96901e1679757d99d77ce7a55291692'],
  ['bdk-core.wasm', '35bb36ee9732ff0432ca3b194f69b132aa4d555ba81fc28c6d922b38cd914189'],
  ['bdk-core.browser.mjs', 'a4e40bf259a4f22582c5e03af17a72b601f4dec5e922def3399eb1b4a1687018'],
  ['bdk-core.umd.js', '38f4e152490b43ae16cf60bb592602a761518a3f772e6072c80327dcd8813a77'],
  ['bdk-core.umd.wasm', 'a840c115b4f9297d33423712983ee95e294adf1056a946dd27c94f93253ceb75']
])

for (const [file, expectedHash] of expected) {
  const bytes = await readFile(new URL(`../src/wasm/${file}`, import.meta.url))
  const actualHash = createHash('sha256').update(bytes).digest('hex')
  if (actualHash !== expectedHash) {
    throw new Error(
      `${file} SHA-256 mismatch: expected ${expectedHash}, received ${actualHash}`
    )
  }
}

console.log(`Verified ${expected.size} pinned BDK artifacts`)
