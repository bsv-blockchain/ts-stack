import { cp, mkdir } from 'node:fs/promises'

await mkdir(new URL('../dist/licenses/', import.meta.url), { recursive: true })
for (const name of ['LICENSE.txt', 'THIRD_PARTY_NOTICES.md']) {
  await cp(
    new URL(`../${name}`, import.meta.url),
    new URL(`../dist/licenses/${name}`, import.meta.url)
  )
}
await cp(
  new URL('../LICENSES/', import.meta.url),
  new URL('../dist/licenses/LICENSES/', import.meta.url),
  {
    recursive: true
  }
)
