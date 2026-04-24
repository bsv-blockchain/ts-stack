#!/usr/bin/env node
import { readFile, writeFile } from 'fs/promises'
import path from 'path'

const THRESHOLD = 0.05

function parseArgs () {
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

function loadJson (filePath) {
  return readFile(filePath, 'utf8').then((data) => JSON.parse(data))
}

function formatMs (value) {
  return value == null ? '—' : `${value.toFixed(2)} ms`
}

function pctChange (baseline, value) {
  if (baseline == null || value == null || baseline === 0) return null
  return ((value - baseline) / baseline) * 100
}

function changeBadge (change) {
  if (change == null) return 'n/a'
  const sign = change > 0 ? '+' : ''
  return `${sign}${change.toFixed(2)}%`
}

function shortSha (sha) {
  if (sha == null) return 'unknown'
  return sha.slice(0, 7)
}

async function main () {
  const options = parseArgs()
  const baseline = await loadJson(options.baseline)
  const branch = await loadJson(options.branch)

  const benchIds = new Set([
    ...Object.keys(baseline ?? {}),
    ...Object.keys(branch ?? {})
  ])

  const rows = []
  const warnings = []
  const kudos = []
  const notes = []

  for (const id of benchIds) {
    const baselineEntry = baseline[id] ?? {}
    const branchEntry = branch[id] ?? {}
    const label = branchEntry.label ?? baselineEntry.label ?? id

    if (baselineEntry.skipped === true) {
      notes.push(`- ${label}: baseline skipped (${baselineEntry.reason ?? 'no script found'}).`)
    }
    if (branchEntry.skipped === true) {
      notes.push(`- ${label}: PR branch skipped (${branchEntry.reason ?? 'no script found'}).`)
    }

    const metrics = new Set([
      ...Object.keys(baselineEntry.metrics ?? {}),
      ...Object.keys(branchEntry.metrics ?? {})
    ])

    if (metrics.size === 0) {
      rows.push(`| ${label} | _no metrics_ | — | — | — | — |`)
      continue
    }

    for (const metric of metrics) {
      const baseVal = baselineEntry.metrics?.[metric]
      const prVal = branchEntry.metrics?.[metric]
      const delta = (baseVal != null && prVal != null) ? prVal - baseVal : null
      const change = pctChange(baseVal, prVal)

      if (typeof change === 'number') {
        if (change > THRESHOLD * 100 + 0.0001) {
          warnings.push(`${label} – ${metric} is ${change.toFixed(2)}% slower (${formatMs(prVal)} vs ${formatMs(baseVal)}).`)
        } else if (change < -THRESHOLD * 100 - 0.0001) {
          kudos.push(`${label} – ${metric} is ${Math.abs(change).toFixed(2)}% faster (${formatMs(prVal)} vs ${formatMs(baseVal)}).`)
        }
      }

      rows.push(`| ${label} | ${metric} | ${formatMs(prVal)} | ${formatMs(baseVal)} | ${delta == null ? '—' : `${delta >= 0 ? '+' : ''}${delta.toFixed(2)} ms`} | ${changeBadge(change)} |`)
    }
  }

  const summaryParts = []
  if (warnings.length > 0) {
    summaryParts.push(`⚠️ ${warnings.length} regression${warnings.length === 1 ? '' : 's'} detected (>${THRESHOLD * 100}% slower).`)
  } else {
    summaryParts.push('✅ No regressions over the 5% threshold detected.')
  }
  if (kudos.length > 0) {
    summaryParts.push(`🎉 ${kudos.length} significant speedup${kudos.length === 1 ? '' : 's'} (>${THRESHOLD * 100}% faster).`)
  }

  const summary = summaryParts.join(' ')
  const header = `## 🏁 Benchmark Comparison (Node 22)\n\nComparing this PR (${shortSha(options.branchRef)}) against master (${shortSha(options.baselineRef)}).\n\n${summary}\n`

  const warningSection = warnings.length > 0
    ? `\n### Regressions\n${warnings.map((w) => `- ⚠️ ${w}`).join('\n')}\n`
    : ''
  const kudosSection = kudos.length > 0
    ? `\n### Speedups\n${kudos.map((m) => `- 🎉 ${m}`).join('\n')}\n`
    : ''

  const table = `\n| Benchmark | Metric | PR Branch | Master | Δ | Change |\n| --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}\n`
  const notesSection = notes.length > 0
    ? `\n### Notes\n${notes.join('\n')}\n`
    : ''

  const body = `${header}${warningSection}${kudosSection}${table}${notesSection}`

  if (options.output != null) {
    await writeFile(options.output, body, 'utf8')
  } else {
    process.stdout.write(body)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
