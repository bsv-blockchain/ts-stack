#!/usr/bin/env node
/**
 * Generates conformance/PARITY_MATRIX.json
 *
 * This file provides a machine-readable view of the conformance corpus parity status.
 * It is especially useful for teams aligning Go, Rust, or Python implementations.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const VECTORS_DIR = join(ROOT, 'conformance/vectors');
const OUTPUT = join(ROOT, 'conformance/PARITY_MATRIX.json');

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.name.endsWith('.json')) {
      files.push(full);
    }
  }
  return files;
}

async function main() {
  const jsonFiles = await walk(VECTORS_DIR);
  const files = [];

  for (const fullPath of jsonFiles) {
    const relPath = relative(VECTORS_DIR, fullPath).replace(/\\/g, '/');
    const raw = await readFile(fullPath, 'utf8');
    const data = JSON.parse(raw);

    const fileId = data.id || null;
    const fileLevelParity = data.parity_class || 'required';
    const vectors = Array.isArray(data.vectors) ? data.vectors : [];

    let required = 0;
    let intended = 0;
    let skipped = 0;
    const skipReasons = new Set();
    const categories = new Set();

    for (const vec of vectors) {
      const p = vec.parity_class || fileLevelParity;
      if (p === 'required') required++;
      else if (p === 'intended') intended++;
      else if (p === 'best-effort') categories.add('best-effort');

      if (vec.skip === true) skipped++;

      if (vec.skip_reason) skipReasons.add(vec.skip_reason);
      if (vec.tags) {
        for (const tag of vec.tags) {
          if (['funded', 'live_overlay', 'state', 'harness'].some(k => tag.includes(k))) {
            categories.add('wallet_stateful_harness');
          }
        }
      }
    }

    const total = vectors.length;
    let effectiveStatus = 'required';
    if (intended > 0) effectiveStatus = intended === total ? 'intended' : 'mixed';
    else if (skipped > 0) effectiveStatus = 'mixed';

    let reasonCategory = 'fully_supported';
    let justification = '';

    if (relPath.startsWith('regressions/')) {
      reasonCategory = 'historical_regression';
      justification = 'Historical cross-SDK bug reproduction vector';
    } else if (relPath.includes('wallet/brc100/')) {
      if (intended > 0 || skipped > 0) {
        reasonCategory = 'wallet_stateful_harness_required';
        justification = 'Requires funded UTXOs + realistic fee model, live overlay, or pre-existing wallet state (see COVERAGE.md)';
      }
    } else if (relPath.includes('sdk/scripts/evaluation')) {
      if (intended > 0) {
        reasonCategory = 'partial_ts_behavioral_difference';
        justification = `${intended} tx_invalid / MINIMALDATA / OP_VER edge cases intentionally differ from reference test vectors`;
      }
    }

    if (skipReasons.size > 0 && !justification) {
      justification = Array.from(skipReasons).join(' | ');
    }

    files.push({
      path: relPath,
      id: fileId,
      total_vectors: total,
      file_level_parity: fileLevelParity,
      effective_status: effectiveStatus,
      required_count: required,
      intended_count: intended,
      skipped_count: skipped,
      reason_category: reasonCategory,
      justification: justification || undefined,
      categories: Array.from(categories)
    });
  }

  // Sort for stability
  files.sort((a, b) => a.path.localeCompare(b.path));

  const totalVectors = files.reduce((sum, f) => sum + f.total_vectors, 0);

  const summary = {
    total_files: files.length,
    total_vectors: totalVectors,
    fully_required_files: files.filter(f => f.effective_status === 'required').length,
    files_with_intended: files.filter(f => f.intended_count > 0).length,
    files_with_mixed_status: files.filter(f => f.effective_status === 'mixed').length,
    vectors_by_status: {
      required: files.reduce((s, f) => s + f.required_count, 0),
      intended: files.reduce((s, f) => s + f.intended_count, 0),
      skipped: files.reduce((s, f) => s + f.skipped_count, 0)
    },
    by_reason_category: {}
  };

  for (const f of files) {
    summary.by_reason_category[f.reason_category] = (summary.by_reason_category[f.reason_category] || 0) + f.total_vectors;
  }

  const matrix = {
    schema_version: '1.0',
    generated_at: new Date().toISOString().split('T')[0],
    source: 'ts-stack conformance corpus',
    description: 'Machine-readable parity status for cross-language SDK implementations (Go, Rust, Python). Use this to track and drive conformance.',
    summary,
    files
  };

  await writeFile(OUTPUT, JSON.stringify(matrix, null, 2) + '\n');
  console.log(`Generated ${OUTPUT}`);
  console.log(`  Files: ${summary.total_files}`);
  console.log(`  Vectors: ${summary.total_vectors}`);
  console.log(`  Fully required files: ${summary.fully_required_files}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});