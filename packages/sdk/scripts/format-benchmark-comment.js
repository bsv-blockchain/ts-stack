#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const THRESHOLD = 0.05

function parseArgs() {
  const args = process.argv.slice(2)
  const options = {
    baseline: null,
    branch: null,
    output: null,
    baselineRef: 'master',
    branchRef: 'PR HEAD'
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--baseline' && args[i + 1] != null) {
      options.baseline = path.resolve(args[++i])
    } else if (arg === '--branch' && args[i + 1] != null) {
      options.branch = path.resolve(args[++i])
    } else if (arg === '--output' && args[i + 1] != null) {
      options.output = path.resolve(args[++i])
    } else if (arg === '--baseline-ref' && args[i + 1] != null) {
      options.baselineRef = args[++i]
    } else if (arg === '--branch-ref' && args[i + 1] != null) {
      options.branchRef = args[++i]
    }
  }

  if (options.baseline == null || options.branch == null) {
    throw new Error('Both --baseline and --branch paths are required.')
  }

  return options
}

function loadJson(filePath) {
  return readFile(filePath, 'utf8').then(data => JSON.parse(data))
}

function formatMs(value) {
  return value == null ? '—' : `${value.toFixed(2)} ms`
}

function pctChange(baseline, value) {
  if (baseline == null || value == null || baseline === 0) return null
  return ((value - baseline) / baseline) * 100
}

function changeBadge(change) {
  if (change == null) return 'n/a'
  const sign = change > 0 ? '+' : ''
  return `${sign}${change.toFixed(2)}%`
}

function shortSha(sha) {
  if (sha == null) return 'unknown'
  return sha.slice(0, 7)
}

function skipNotes(label, baselineEntry, branchEntry) {
  const notes = []
  if (baselineEntry.skipped === true) {
    notes.push(`- ${label}: baseline skipped (${baselineEntry.reason ?? 'no script found'}).`)
  }
  if (branchEntry.skipped === true) {
    notes.push(`- ${label}: PR branch skipped (${branchEntry.reason ?? 'no script found'}).`)
  }
  return notes
}

function formatDelta(delta) {
  if (delta == null) return '—'
  const sign = delta >= 0 ? '+' : ''
  return `${sign}${delta.toFixed(2)} ms`
}

function compareMetric(label, metric, baselineEntry, branchEntry) {
  const baseVal = baselineEntry.metrics?.[metric]
  const prVal = branchEntry.metrics?.[metric]
  const delta = baseVal != null && prVal != null ? prVal - baseVal : null
  const change = pctChange(baseVal, prVal)
  let warning
  let kudo

  if (typeof change === 'number' && change > THRESHOLD * 100 + 0.0001) {
    warning = `${label} – ${metric} is ${change.toFixed(2)}% slower (${formatMs(prVal)} vs ${formatMs(baseVal)}).`
  } else if (typeof change === 'number' && change < -THRESHOLD * 100 - 0.0001) {
    kudo = `${label} – ${metric} is ${Math.abs(change).toFixed(2)}% faster (${formatMs(prVal)} vs ${formatMs(baseVal)}).`
  }

  return {
    row: `| ${label} | ${metric} | ${formatMs(prVal)} | ${formatMs(baseVal)} | ${formatDelta(delta)} | ${changeBadge(change)} |`,
    warning,
    kudo
  }
}

function compareBenchmark(id, baseline, branch) {
  const baselineEntry = baseline[id] ?? {}
  const branchEntry = branch[id] ?? {}
  const label = branchEntry.label ?? baselineEntry.label ?? id
  const metrics = new Set([
    ...Object.keys(baselineEntry.metrics ?? {}),
    ...Object.keys(branchEntry.metrics ?? {})
  ])

  if (metrics.size === 0) {
    return {
      rows: [`| ${label} | _no metrics_ | — | — | — | — |`],
      warnings: [],
      kudos: [],
      notes: skipNotes(label, baselineEntry, branchEntry)
    }
  }

  const comparisons = [...metrics].map(metric =>
    compareMetric(label, metric, baselineEntry, branchEntry)
  )
  return {
    rows: comparisons.map(comparison => comparison.row),
    warnings: comparisons.flatMap(comparison =>
      comparison.warning === undefined ? [] : [comparison.warning]
    ),
    kudos: comparisons.flatMap(comparison =>
      comparison.kudo === undefined ? [] : [comparison.kudo]
    ),
    notes: skipNotes(label, baselineEntry, branchEntry)
  }
}

function buildSummary(warnings, kudos) {
  const summaryParts = [
    warnings.length > 0
      ? `⚠️ ${warnings.length} regression${warnings.length === 1 ? '' : 's'} detected (>${THRESHOLD * 100}% slower).`
      : '✅ No regressions over the 5% threshold detected.'
  ]
  if (kudos.length > 0) {
    summaryParts.push(
      `🎉 ${kudos.length} significant speedup${kudos.length === 1 ? '' : 's'} (>${THRESHOLD * 100}% faster).`
    )
  }
  return summaryParts.join(' ')
}

async function main() {
  const options = parseArgs()
  const baseline = await loadJson(options.baseline)
  const branch = await loadJson(options.branch)

  const benchIds = new Set([...Object.keys(baseline ?? {}), ...Object.keys(branch ?? {})])

  const comparisons = [...benchIds].map(id => compareBenchmark(id, baseline, branch))
  const rows = comparisons.flatMap(comparison => comparison.rows)
  const warnings = comparisons.flatMap(comparison => comparison.warnings)
  const kudos = comparisons.flatMap(comparison => comparison.kudos)
  const notes = comparisons.flatMap(comparison => comparison.notes)
  const summary = buildSummary(warnings, kudos)
  const header = `## 🏁 Benchmark Comparison (Node 22)\n\nComparing this PR (${shortSha(options.branchRef)}) against master (${shortSha(options.baselineRef)}).\n\n${summary}\n`

  const warningLines = warnings.map(warning => `- ⚠️ ${warning}`).join('\n')
  const warningSection = warnings.length > 0 ? `\n### Regressions\n${warningLines}\n` : ''
  const kudosLines = kudos.map(message => `- 🎉 ${message}`).join('\n')
  const kudosSection = kudos.length > 0 ? `\n### Speedups\n${kudosLines}\n` : ''

  const table = `\n| Benchmark | Metric | PR Branch | Master | Δ | Change |\n| --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}\n`
  const notesSection = notes.length > 0 ? `\n### Notes\n${notes.join('\n')}\n` : ''

  const body = `${header}${warningSection}${kudosSection}${table}${notesSection}`

  if (options.output != null) {
    await writeFile(options.output, body, 'utf8')
  } else {
    process.stdout.write(body)
  }
}

try {
  await main()
} catch (err) {
  console.error(err)
  process.exitCode = 1
}
