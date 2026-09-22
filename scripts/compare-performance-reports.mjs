#!/usr/bin/env node

import fs from 'node:fs/promises'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

/** UTF-16 code-unit order, the same order as a comparator-less `Array#sort`. */
function compareCodeUnits(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

export function comparePerformanceReports(baseline, candidate) {
  if (baseline.benchmark !== candidate.benchmark) throw new Error('benchmark identities differ')
  if (baseline.payloadBytes !== candidate.payloadBytes) throw new Error('benchmark payloads differ')

  const baselineNames = Object.keys(baseline.measurements ?? {}).sort(compareCodeUnits)
  const candidateNames = Object.keys(candidate.measurements ?? {}).sort(compareCodeUnits)
  if (JSON.stringify(baselineNames) !== JSON.stringify(candidateNames)) {
    throw new Error('benchmark measurement sets differ')
  }

  const rows = []
  let baselineAggregate = 0
  let candidateAggregate = 0
  for (const name of baselineNames) {
    const baselineMs = baseline.measurements[name]?.medianMs
    const candidateMs = candidate.measurements[name]?.medianMs
    if (
      !Number.isFinite(baselineMs) ||
      baselineMs < 0 ||
      !Number.isFinite(candidateMs) ||
      candidateMs < 0
    ) {
      throw new Error(`${name} does not contain non-negative finite medians`)
    }
    baselineAggregate += baselineMs
    candidateAggregate += candidateMs
    rows.push({
      name,
      baselineMs,
      candidateMs,
      deltaMs: candidateMs - baselineMs,
      deltaPercent: baselineMs === 0 ? 0 : ((candidateMs - baselineMs) / baselineMs) * 100
    })
  }
  const aggregate = {
    baselineMs: baselineAggregate,
    candidateMs: candidateAggregate,
    deltaMs: candidateAggregate - baselineAggregate,
    deltaPercent:
      baselineAggregate === 0
        ? 0
        : ((candidateAggregate - baselineAggregate) / baselineAggregate) * 100
  }
  const violations = rows.filter(row => row.deltaMs > 0)
  if (aggregate.deltaMs > 0) violations.push({ name: '<aggregate>', ...aggregate })
  return { rows, aggregate, violations }
}

async function main(args) {
  if (args.length !== 2) {
    throw new Error('Usage: compare-performance-reports.mjs <baseline-report> <candidate-report>')
  }
  const [baseline, candidate] = await Promise.all(
    args.map(async file => JSON.parse(await fs.readFile(file, 'utf8')))
  )
  const comparison = comparePerformanceReports(baseline, candidate)
  for (const violation of comparison.violations) {
    console.error(
      `${violation.name}: ${violation.candidateMs.toFixed(6)}ms > ` +
        `${violation.baselineMs.toFixed(6)}ms (+${violation.deltaPercent.toFixed(2)}%)`
    )
  }
  console.log(`Aggregate: ${JSON.stringify(comparison.aggregate)}`)
  if (comparison.violations.length > 0) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
