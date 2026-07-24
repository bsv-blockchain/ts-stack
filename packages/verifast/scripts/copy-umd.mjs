import { copyFile } from 'node:fs/promises'

await copyFile(
  new URL('../dist/umd/verifast.cjs', import.meta.url),
  new URL('../dist/umd/verifast.js', import.meta.url)
)
