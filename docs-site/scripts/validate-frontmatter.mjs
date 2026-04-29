#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'fs'
import { resolve, join, relative, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'

const require = createRequire(import.meta.url)
const matter = require('gray-matter')

const __dirname = dirname(fileURLToPath(import.meta.url))
const DOCS_ROOT = resolve(__dirname, '../../docs')
const SCHEMA_PATH = resolve(__dirname, '../../docs/_schemas/page.schema.json')

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))
const ajv = new Ajv({ allErrors: true })
addFormats(ajv)
const validate = ajv.compile(schema)

function parseFrontmatter(content) {
  const { data } = matter(content)
  return Object.keys(data).length > 0 ? data : null
}

function walk(dir) {
  const results = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      if (name.startsWith('_') || name.startsWith('.')) continue
      results.push(...walk(full))
    } else if (name.endsWith('.md')) {
      results.push(full)
    }
  }
  return results
}

let errors = 0
const files = walk(DOCS_ROOT)

for (const file of files) {
  const content = readFileSync(file, 'utf8')
  const fm = parseFrontmatter(content)
  if (!fm) {
    console.error(`MISSING FRONTMATTER: ${relative(DOCS_ROOT, file)}`)
    errors++
    continue
  }
  const valid = validate(fm)
  if (!valid) {
    console.error(`INVALID FRONTMATTER: ${relative(DOCS_ROOT, file)}`)
    for (const err of validate.errors ?? []) {
      console.error(`  ${err.instancePath || '(root)'}: ${err.message}`)
    }
    errors++
  }
}

if (errors > 0) {
  console.error(`\nValidation failed: ${errors} file(s) with frontmatter errors`)
  process.exit(1)
} else {
  console.log(`Frontmatter valid: ${files.length} files checked`)
}
