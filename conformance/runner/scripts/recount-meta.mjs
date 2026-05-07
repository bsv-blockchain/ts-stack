#!/usr/bin/env node
/**
 * recount-meta.mjs
 *
 * Walks conformance/vectors/ recursively, recomputes total_files and
 * total_vectors, sets last_updated to today's ISO date (YYYY-MM-DD), and
 * writes the result back to conformance/META.json.
 *
 * Idempotent — safe to run multiple times.
 *
 * Usage:
 *   node conformance/runner/scripts/recount-meta.mjs
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs'
import { join, extname, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// scripts/ → runner/ → conformance/
const CONFORMANCE_DIR = join(__dirname, '..', '..')
const VECTORS_DIR = join(CONFORMANCE_DIR, 'vectors')
const META_PATH = join(CONFORMANCE_DIR, 'META.json')

function findJsonFiles (dir) {
  const results = []
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry)
    if (statSync(fullPath).isDirectory()) {
      results.push(...findJsonFiles(fullPath))
    } else if (extname(entry).toLowerCase() === '.json') {
      results.push(fullPath)
    }
  }
  return results
}

const files = findJsonFiles(VECTORS_DIR)
let totalFiles = 0
let totalVectors = 0

for (const f of files) {
  totalFiles++
  try {
    const d = JSON.parse(readFileSync(f, 'utf-8'))
    if (Array.isArray(d.vectors)) {
      totalVectors += d.vectors.length
    }
  } catch {
    // malformed file — count it but don't add vectors
  }
}

const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD

const meta = JSON.parse(readFileSync(META_PATH, 'utf-8'))
meta.stats = meta.stats ?? {}
meta.stats.total_files = totalFiles
meta.stats.total_vectors = totalVectors
meta.stats.last_updated = today

writeFileSync(META_PATH, JSON.stringify(meta, null, 2) + '\n', 'utf-8')

console.log(`recount-meta: ${totalFiles} files, ${totalVectors} vectors, last_updated=${today}`)
console.log(`Written to ${META_PATH}`)
