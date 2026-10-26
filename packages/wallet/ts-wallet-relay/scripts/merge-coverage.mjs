import { readFile, writeFile } from 'node:fs/promises'

const primaryPath = new URL('../coverage/lcov.info', import.meta.url)
const scriptsPath = new URL('../coverage/scripts.lcov.info', import.meta.url)
const [primary, scripts] = await Promise.all([
  readFile(primaryPath, 'utf8'),
  readFile(scriptsPath, 'utf8')
])

await writeFile(primaryPath, `${primary.trimEnd()}\n${scripts.trimStart()}`)
