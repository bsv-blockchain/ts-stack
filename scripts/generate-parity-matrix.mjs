#!/usr/bin/env node
/**
 * Generates conformance/PARITY_MATRIX.json
 *
 * This file provides a machine-readable view of the conformance corpus parity status.
 * It is especially useful for teams aligning Go, Rust, or Python implementations.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(__dirname, '..')
const VECTORS_DIR = join(ROOT, 'conformance/vectors')
const OUTPUT = join(ROOT, 'conformance/PARITY_MATRIX.json')

const STATEFUL_TAG_KEYS = ['funded', 'live_overlay', 'state', 'harness']

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walk(full)))
    } else if (entry.name.endsWith('.json')) {
      files.push(full)
    }
  }
  return files
}

function isStatefulTag(tag) {
  return STATEFUL_TAG_KEYS.some(k => tag.includes(k))
}

function tallyParity(parity, counts, categories) {
  if (parity === 'required') counts.required++
  else if (parity === 'intended') counts.intended++
  else if (parity === 'best-effort') categories.add('best-effort')
}

function collectTagCategories(tags, categories) {
  if (!tags) return
  for (const tag of tags) {
    if (isStatefulTag(tag)) categories.add('wallet_stateful_harness')
  }
}

function aggregateVectors(vectors, fileLevelParity) {
  const counts = { required: 0, intended: 0, skipped: 0 }
  const skipReasons = new Set()
  const categories = new Set()

  for (const vec of vectors) {
    tallyParity(vec.parity_class || fileLevelParity, counts, categories)
    if (vec.skip === true) counts.skipped++
    if (vec.skip_reason) skipReasons.add(vec.skip_reason)
    collectTagCategories(vec.tags, categories)
  }

  return { counts, skipReasons, categories }
}

function effectiveStatus(counts, total) {
  if (counts.intended > 0) return counts.intended === total ? 'intended' : 'mixed'
  if (counts.skipped > 0) return 'mixed'
  return 'required'
}

function classifyReason(relPath, counts) {
  if (relPath.startsWith('regressions/')) {
    return {
      reasonCategory: 'historical_regression',
      justification: 'Historical cross-SDK bug reproduction vector'
    }
  }
  if (relPath.includes('wallet/brc100/') && (counts.intended > 0 || counts.skipped > 0)) {
    return {
      reasonCategory: 'wallet_stateful_harness_required',
      justification:
        'Requires funded UTXOs + realistic fee model, live overlay, or pre-existing wallet state (see COVERAGE.md)'
    }
  }
  if (relPath.includes('sdk/scripts/evaluation') && counts.intended > 0) {
    return {
      reasonCategory: 'partial_ts_behavioral_difference',
      justification: `${counts.intended} tx_invalid / MINIMALDATA / OP_VER edge cases intentionally differ from reference test vectors`
    }
  }
  return { reasonCategory: 'fully_supported', justification: '' }
}

async function describeFile(fullPath) {
  const relPath = relative(VECTORS_DIR, fullPath).replaceAll('\\', '/')
  const raw = await readFile(fullPath, 'utf8')
  const data = JSON.parse(raw)

  const fileId = data.id || null
  const fileLevelParity = data.parity_class || 'required'
  const vectors = Array.isArray(data.vectors) ? data.vectors : []

  const { counts, skipReasons, categories } = aggregateVectors(vectors, fileLevelParity)
  const total = vectors.length
  const { reasonCategory, justification: baseJustification } = classifyReason(relPath, counts)
  const justification =
    baseJustification || (skipReasons.size > 0 ? Array.from(skipReasons).join(' | ') : '')

  return {
    path: relPath,
    id: fileId,
    total_vectors: total,
    file_level_parity: fileLevelParity,
    effective_status: effectiveStatus(counts, total),
    required_count: counts.required,
    intended_count: counts.intended,
    skipped_count: counts.skipped,
    reason_category: reasonCategory,
    justification: justification || undefined,
    categories: Array.from(categories)
  }
}

function buildSummary(files) {
  const summary = {
    total_files: files.length,
    total_vectors: files.reduce((sum, f) => sum + f.total_vectors, 0),
    fully_required_files: files.filter(f => f.effective_status === 'required').length,
    files_with_intended: files.filter(f => f.intended_count > 0).length,
    files_with_mixed_status: files.filter(f => f.effective_status === 'mixed').length,
    vectors_by_status: {
      required: files.reduce((s, f) => s + f.required_count, 0),
      intended: files.reduce((s, f) => s + f.intended_count, 0),
      skipped: files.reduce((s, f) => s + f.skipped_count, 0)
    },
    by_reason_category: {}
  }

  for (const f of files) {
    summary.by_reason_category[f.reason_category] =
      (summary.by_reason_category[f.reason_category] || 0) + f.total_vectors
  }

  return summary
}

try {
  const jsonFiles = await walk(VECTORS_DIR)
  const files = []
  for (const fullPath of jsonFiles) {
    files.push(await describeFile(fullPath))
  }
  files.sort((a, b) => a.path.localeCompare(b.path))

  const summary = buildSummary(files)
  const matrix = {
    schema_version: '1.0',
    generated_at: new Date().toISOString().split('T')[0],
    source: 'ts-stack conformance corpus',
    description:
      'Machine-readable parity status for cross-language SDK implementations (Go, Rust, Python). Use this to track and drive conformance.',
    summary,
    files
  }

  await writeFile(OUTPUT, JSON.stringify(matrix, null, 2) + '\n')
  console.log(`Generated ${OUTPUT}`)
  console.log(`  Files: ${summary.total_files}`)
  console.log(`  Vectors: ${summary.total_vectors}`)
  console.log(`  Fully required files: ${summary.fully_required_files}`)
} catch (err) {
  console.error(err)
  process.exit(1)
}
