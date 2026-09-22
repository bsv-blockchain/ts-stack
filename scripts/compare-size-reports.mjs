#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const dimensions = ['raw', 'gzip', 'brotli']

/** UTF-16 code-unit order, the same order as a comparator-less `Array#sort`. */
function compareCodeUnits(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function flatten(report) {
  const values = new Map()
  for (const [tool, measurement] of Object.entries(report.measurements ?? {})) {
    const bytes = measurement.bytes ?? measurement
    for (const dimension of dimensions) {
      const value = bytes?.[dimension]
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${report.package} ${tool}.${dimension} is not a non-negative integer`)
      }
      values.set(`${tool}.${dimension}`, value)
    }
  }
  if (values.size === 0) throw new Error(`${report.package} has no size measurements`)
  return values
}

async function readReports(directory) {
  const reports = new Map()
  for (const file of (await fs.readdir(directory)).filter(file => file.endsWith('.json')).sort()) {
    const report = JSON.parse(await fs.readFile(path.join(directory, file), 'utf8'))
    if (typeof report.package !== 'string' || report.package === '') {
      throw new Error(`${file} does not identify a package`)
    }
    if (reports.has(report.package)) throw new Error(`duplicate report for ${report.package}`)
    reports.set(report.package, { file, values: flatten(report) })
  }
  return reports
}

export function compareSizeReports(baseline, candidate) {
  const violations = []
  const rows = []
  const baselinePackages = [...baseline.keys()].sort(compareCodeUnits)
  const candidatePackages = [...candidate.keys()].sort(compareCodeUnits)
  if (JSON.stringify(candidatePackages) !== JSON.stringify(baselinePackages)) {
    throw new Error('baseline and candidate package sets differ')
  }

  let baselineAggregate = 0
  let candidateAggregate = 0
  for (const packageName of baselinePackages) {
    const before = baseline.get(packageName).values
    const after = candidate.get(packageName).values
    const baselineMetrics = [...before.keys()].sort(compareCodeUnits)
    if (
      JSON.stringify([...after.keys()].sort(compareCodeUnits)) !== JSON.stringify(baselineMetrics)
    ) {
      throw new Error(`${packageName} baseline and candidate metric sets differ`)
    }
    for (const metric of baselineMetrics) {
      const baselineBytes = before.get(metric)
      const candidateBytes = after.get(metric)
      baselineAggregate += baselineBytes
      candidateAggregate += candidateBytes
      const deltaBytes = candidateBytes - baselineBytes
      const deltaPercent = baselineBytes === 0 ? 0 : (deltaBytes / baselineBytes) * 100
      const row = {
        package: packageName,
        metric,
        baselineBytes,
        candidateBytes,
        deltaBytes,
        deltaPercent
      }
      rows.push(row)
      if (deltaBytes > 0) violations.push(row)
    }
  }

  const aggregate = {
    baselineBytes: baselineAggregate,
    candidateBytes: candidateAggregate,
    deltaBytes: candidateAggregate - baselineAggregate,
    deltaPercent:
      baselineAggregate === 0
        ? 0
        : ((candidateAggregate - baselineAggregate) / baselineAggregate) * 100
  }
  if (aggregate.deltaBytes > 0)
    violations.push({ package: '<aggregate>', metric: 'all', ...aggregate })
  return { rows, aggregate, violations }
}

async function main(args) {
  if (args.length !== 2) {
    throw new Error('Usage: compare-size-reports.mjs <baseline-directory> <candidate-directory>')
  }
  const [baseline, candidate] = await Promise.all(
    args.map(directory => readReports(path.resolve(directory)))
  )
  const comparison = compareSizeReports(baseline, candidate)
  for (const violation of comparison.violations) {
    const baselineBytes = violation.baselineBytes
    const candidateBytes = violation.candidateBytes
    console.error(
      `${violation.package} ${violation.metric}: ${candidateBytes} > ${baselineBytes} ` +
        `(+${violation.deltaBytes} bytes, +${violation.deltaPercent.toFixed(2)}%)`
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
