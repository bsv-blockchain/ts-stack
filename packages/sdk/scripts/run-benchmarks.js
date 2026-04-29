#!/usr/bin/env node
import { access } from 'fs/promises'
import { writeFile } from 'fs/promises'
import { spawn } from 'child_process'
import path from 'path'

const DEFAULT_REPO = process.cwd()

const BENCHMARKS = [
  {
    id: 'bignumber',
    label: 'BigNumber Arithmetic',
    commands: [
      { script: 'benchmarks/bignumber-bench.js', args: ['200000', '1', '1'] }
    ]
  },
  {
    id: 'bn-serialization',
    label: 'BigNumber Serialization',
    commands: [
      { script: 'benchmarks/bn-serialization-bench.js', args: ['200000', '1'] },
      { script: 'benchmarks/serialization-bench.js', args: ['200000', '1'] }
    ]
  },
  {
    id: 'script-serialization',
    label: 'Script Serialization',
    commands: [
      { script: 'benchmarks/script-serialization-bench.js', args: [] }
    ]
  },
  {
    id: 'transaction',
    label: 'Transaction Verification',
    commands: [
      { script: 'benchmarks/transaction-bench.js', args: [] }
    ]
  },
  {
    id: 'symmetric-key',
    label: 'Symmetric Key',
    commands: [
      { script: 'benchmarks/symmetric-key-bench.js', args: [] }
    ]
  },
  {
    id: 'reader-writer',
    label: 'Reader & Writer',
    commands: [
      { script: 'benchmarks/reader-writer-bench.js', args: [] }
    ]
  },
  {
    id: 'atomic-beef',
    label: 'Atomic BEEF',
    commands: [
      { script: 'benchmarks/atomic-beef-bench.js', args: [] }
    ]
  }
]

const LINE_REGEX = /^([^:\n]+?):\s*([\d.]+)ms\b/gm

function parseArgs () {
  const args = process.argv.slice(2)
  const options = {
    repo: DEFAULT_REPO,
    output: null
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--repo' && args[i + 1] != null) {
      options.repo = path.resolve(args[++i])
    } else if (arg === '--output' && args[i + 1] != null) {
      options.output = path.resolve(args[++i])
    }
  }

  return options
}

async function fileExists (filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function selectCommand (repo, commands) {
  for (const command of commands) {
    const scriptPath = path.join(repo, command.script)
    if (await fileExists(scriptPath)) {
      return command
    }
  }
  return null
}

async function runBenchmarkCommand (repo, scriptPath, args, label) {
  return await new Promise((resolve, reject) => {
    const proc = spawn('node', [scriptPath, ...args], {
      cwd: repo,
      env: process.env
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (chunk) => {
      process.stdout.write(`[${label}] ${chunk}`)
      stdout += chunk
    })

    proc.stderr.on('data', (chunk) => {
      process.stderr.write(`[${label}][err] ${chunk}`)
      stderr += chunk
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        reject(new Error(`Benchmark "${label}" exited with code ${code}. ${stderr}`))
      }
    })
  })
}

function parseMetrics (output) {
  const metrics = {}
  let match
  while ((match = LINE_REGEX.exec(output)) !== null) {
    const name = match[1].trim()
    const value = Number(match[2])
    if (!Number.isNaN(value)) {
      metrics[name] = value
    }
  }
  return metrics
}

async function main () {
  const options = parseArgs()
  const results = {}

  for (const bench of BENCHMARKS) {
    const selected = await selectCommand(options.repo, bench.commands)
    if (selected == null) {
      results[bench.id] = {
        label: bench.label,
        skipped: true,
        reason: 'No matching script found',
        scriptsTried: bench.commands.map(cmd => cmd.script)
      }
      console.log(`[${bench.label}] Skipped (script not found)`)
      continue
    }

    console.log(`[${bench.label}] Running ${selected.script}`)
    const { stdout } = await runBenchmarkCommand(
      options.repo,
      selected.script,
      selected.args,
      bench.label
    )

    const metrics = parseMetrics(stdout)
    results[bench.id] = {
      label: bench.label,
      script: selected.script,
      metrics,
      success: true
    }
  }

  if (options.output != null) {
    await writeFile(options.output, JSON.stringify(results, null, 2), 'utf8')
  } else {
    console.log(JSON.stringify(results, null, 2))
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
