#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DOCS_ASSETS = resolve(__dirname, '../../docs/assets')
const DIST_ASSETS = resolve(__dirname, '../dist/assets')

mkdirSync(DIST_ASSETS, { recursive: true })

for (const folder of ['diagrams', 'images']) {
  const source = join(DOCS_ASSETS, folder)
  if (!existsSync(source)) continue

  cpSync(source, join(DIST_ASSETS, folder), {
    recursive: true,
    filter: (path) => !relative(source, path).split(/[/\\]/).some((part) => part.startsWith('.')),
  })
}
