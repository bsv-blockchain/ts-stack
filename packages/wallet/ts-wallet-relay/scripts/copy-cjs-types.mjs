import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = fileURLToPath(new URL('../dist', import.meta.url))

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const source = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      await visit(source)
      continue
    }
    if (!entry.name.endsWith('.d.ts')) continue

    const target = source.replace(/\.d\.ts$/, '.d.cts')
    const declaration = (await readFile(source, 'utf8')).replace(
      /sourceMappingURL=([^/\n]+)\.d\.ts\.map/g,
      'sourceMappingURL=$1.d.cts.map'
    )
    await writeFile(target, declaration)

    const sourceMap = `${source}.map`
    try {
      const map = JSON.parse(await readFile(sourceMap, 'utf8'))
      map.file = String(map.file).replace(/\.d\.ts$/, '.d.cts')
      await writeFile(`${target}.map`, `${JSON.stringify(map)}\n`)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

await visit(dist)
