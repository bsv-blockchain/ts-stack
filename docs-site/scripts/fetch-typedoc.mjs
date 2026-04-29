#!/usr/bin/env node
import { execSync } from 'child_process'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../..')
const DIST = resolve(__dirname, '../dist')
const TMP = resolve(ROOT, 'tmp/typedoc-fetch')

if (!existsSync(DIST)) {
  console.log('dist/ not found — skipping TypeDoc merge (run build first)')
  process.exit(0)
}

function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`)
  execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...opts })
}

try {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true })
  mkdirSync(TMP, { recursive: true })

  run('git fetch origin gh-pages --depth=1')

  try {
    run(`git --work-tree="${TMP}" checkout origin/gh-pages -- api/`)
    const apiSrc = resolve(TMP, 'api')
    const apiDst = resolve(DIST, 'api')
    if (existsSync(apiSrc)) {
      if (existsSync(apiDst)) rmSync(apiDst, { recursive: true })
      run(`cp -R "${apiSrc}" "${apiDst}"`)
      console.log('TypeDoc /api/ merged into dist/')
    } else {
      console.log('No api/ directory in gh-pages — skipping')
    }
  } catch {
    console.log('No api/ in gh-pages branch — skipping TypeDoc merge')
  }
} catch (err) {
  console.warn('fetch-typedoc: could not fetch gh-pages branch:', err.message)
  console.warn('TypeDoc /api/ will be absent from this deploy.')
} finally {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true })
}
