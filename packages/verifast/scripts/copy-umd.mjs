import { copyFile, readFile, writeFile } from 'node:fs/promises'

await copyFile(
  new URL('../dist/umd/verifast.cjs', import.meta.url),
  new URL('../dist/umd/verifast.js', import.meta.url)
)
await copyFile(
  new URL('../dist/umd/verifast.cjs.map', import.meta.url),
  new URL('../dist/umd/verifast.js.map', import.meta.url)
)

const browserBundle = new URL('../dist/umd/verifast.js', import.meta.url)
const source = await readFile(browserBundle, 'utf8')
await writeFile(browserBundle, source.replace('verifast.cjs.map', 'verifast.js.map'))
