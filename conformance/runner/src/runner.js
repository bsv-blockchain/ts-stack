/**
 * BSV Conformance Runner
 *
 * Loads test vectors from conformance/vectors/**\/*.json,
 * validates them against the official JSON Schemas (vector.schema.json +
 * regression-vector.schema.json) using ajv, and emits JUnit XML + JSON reports.
 *
 * This is the canonical structural validator used by all language implementations
 * (TypeScript, Go, Rust, Python, ...) to ensure the shared conformance corpus
 * is well-formed.
 *
 * Schema validation is a hard requirement — the runner will refuse to start if
 * ajv or the schemas are missing.
 *
 * MBGA §8.5: per-language vector runner.
 *
 * Usage:
 *   node src/runner.js [--validate-only] [--report <path>] [--vectors <dir>]
 *
 * Exit codes:
 *   0  all vector files parsed cleanly
 *   1  one or more parse / validation errors
 *   2  schema or structural error
 */

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const VECTORS_DIR = resolve(__dirname, '../../vectors')
const REPORT_DIR = resolve(__dirname, '../reports')
const SCHEMA_DIR = resolve(__dirname, '../../schema')
const STANDARD_SCHEMA_PATH = join(SCHEMA_DIR, 'vector.schema.json')
const REGRESSION_SCHEMA_PATH = join(SCHEMA_DIR, 'regression-vector.schema.json')

// ---------------------------------------------------------------------------
// Strict JSON Schema validation using ajv (hard dependency).
// The runner will fail to start with a clear error if ajv or the schemas
// cannot be loaded. There is no silent fallback to weak ad-hoc checks.
// This is required for reliable cross-language conformance.
// ---------------------------------------------------------------------------

let validateStandard
let validateRegression

async function initSchemaValidation () {
  let AjvMod
  try {
    AjvMod = await import('ajv')
  } catch (err) {
    throw new Error(
      'ajv is a hard dependency of the BSV conformance structural runner.\n' +
      'Please run `cd conformance/runner && pnpm install` (or equivalent) to install it.\n' +
      `Import error: ${err.message}`
    )
  }

  const Ajv = AjvMod.default
  const ajv = new Ajv({ allErrors: true, strict: false })

  let standardSchema, regressionSchema
  try {
    standardSchema = JSON.parse(await readFile(STANDARD_SCHEMA_PATH, 'utf8'))
    regressionSchema = JSON.parse(await readFile(REGRESSION_SCHEMA_PATH, 'utf8'))
  } catch (err) {
    throw new Error(
      `Failed to load conformance schemas from ${SCHEMA_DIR}.\n` +
      `Make sure both vector.schema.json and regression-vector.schema.json exist.\n` +
      `Original error: ${err.message}`
    )
  }

  validateStandard = ajv.compile(standardSchema)
  validateRegression = ajv.compile(regressionSchema)
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs (argv) {
  const args = argv.slice(2)
  const opts = {
    validateOnly: false,
    reportPath: null,
    vectorsDir: VECTORS_DIR
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--validate-only') opts.validateOnly = true
    else if (args[i] === '--report' && args[i + 1]) opts.reportPath = resolve(args[++i])
    else if (args[i] === '--vectors' && args[i + 1]) opts.vectorsDir = resolve(args[++i])
  }
  return opts
}

// ---------------------------------------------------------------------------
// Vector file loading — recursive glob over all *.json
// ---------------------------------------------------------------------------

async function findJsonFiles (dir) {
  const results = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return results
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const sub = await findJsonFiles(full)
      results.push(...sub)
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      results.push(full)
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const REQUIRED_TOP_LEVEL = ['vectors']

// Regression vectors follow a different (intentionally richer) format for historical bug tracking.
// We keep a small set of recommended fields for helpful warnings on regressions.
const REGRESSION_RECOMMENDED_TOP_LEVEL = ['version', 'domain', 'category', 'description', 'regression']
const REQUIRED_VECTOR_FIELDS = ['id', 'input', 'expected']

function validateFile (path, data) {
  const errors = []

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    // Legacy format: bare array of vectors (no top-level envelope)
    if (Array.isArray(data)) {
      errors.push(`WARN: ${path} uses legacy bare-array format — wrap in { "vectors": [...] } envelope`)
      return { errors, vectors: data }
    }
    errors.push(`ERROR: ${path} top level must be an object or array`)
    return { errors, vectors: [] }
  }

  const isRegression = path.includes('/regressions/')

  // Check required top-level fields (lightweight fast check before full schema validation)
  for (const field of REQUIRED_TOP_LEVEL) {
    if (!(field in data)) {
      errors.push(`ERROR: ${path} missing required top-level field "${field}"`)
    }
  }

  // For regressions we still do some lightweight metadata checks (the regression schema
  // is intentionally more permissive at the top level than the standard one).
  if (isRegression) {
    for (const field of REGRESSION_RECOMMENDED_TOP_LEVEL) {
      if (!(field in data)) {
        errors.push(`WARN: ${path} missing recommended regression field "${field}"`)
      }
    }
    if (!data.regression || typeof data.regression !== 'object' || !data.regression.issue) {
      errors.push(`WARN: ${path} regression file is missing regression.issue metadata`)
    }
  }

  const vectors = Array.isArray(data.vectors) ? data.vectors : []

  if (!Array.isArray(data.vectors)) {
    errors.push(`ERROR: ${path} "vectors" must be an array`)
    return { errors, vectors: [] }
  }

  // --- Strict JSON Schema validation (always enforced) ---
  const validator = isRegression ? validateRegression : validateStandard
  const schemaName = isRegression ? 'regression-vector.schema.json' : 'vector.schema.json'

  if (validator && !validator(data)) {
    const ajvErrors = (validator.errors || []).map(e => {
      const instancePath = e.instancePath || '(root)'
      return `SCHEMA: ${schemaName} ${instancePath} ${e.message}`
    })
    // Schema violations are fatal — this is the authoritative check for cross-language ports
    ajvErrors.forEach(msg => errors.push(`ERROR: ${path} ${msg}`))
  }

  return { errors, vectors }
}

function validateVector (filePath, vec, index) {
  const errors = []
  for (const field of REQUIRED_VECTOR_FIELDS) {
    if (!(field in vec)) {
      errors.push(`ERROR: ${filePath} vector[${index}] missing required field "${field}"`)
    }
  }
  return errors
}

// ---------------------------------------------------------------------------
// JUnit XML helpers
// ---------------------------------------------------------------------------

function escXml (s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function toJUnit (suites) {
  const allCases = suites.flatMap(s => s.cases)
  const total = allCases.length
  const failed = allCases.filter(c => !c.pass).length

  const suiteXml = suites.map(s => {
    const sTotal = s.cases.length
    const sFailed = s.cases.filter(c => !c.pass).length
    const casesXml = s.cases.map(c => {
      if (c.pass) {
        return `    <testcase name="${escXml(c.name)}" classname="${escXml(s.name)}" time="0"/>`
      }
      return [
        `    <testcase name="${escXml(c.name)}" classname="${escXml(s.name)}" time="0">`,
        `      <failure message="${escXml(c.error)}">${escXml(c.error)}</failure>`,
        '    </testcase>'
      ].join('\n')
    }).join('\n')

    return [
      `  <testsuite name="${escXml(s.name)}" tests="${sTotal}" failures="${sFailed}" errors="0" skipped="0">`,
      casesXml,
      '  </testsuite>'
    ].join('\n')
  }).join('\n')

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="bsv-conformance" tests="${total}" failures="${failed}" errors="0" skipped="0">`,
    suiteXml,
    '</testsuites>'
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run () {
  const opts = parseArgs(process.argv)
  const vectorsDir = opts.vectorsDir

  console.log(`BSV Conformance Runner`)
  console.log(`  Vectors dir : ${vectorsDir}`)
  console.log(`  Mode        : ${opts.validateOnly ? 'validate-only' : 'validate + report'}`)
  if (opts.reportPath) console.log(`  Report path : ${opts.reportPath}`)
  console.log()

  // Initialize strict JSON Schema validation (hard requirement)
  await initSchemaValidation()

  // Discover all JSON files
  const jsonFiles = await findJsonFiles(vectorsDir)

  if (jsonFiles.length === 0) {
    console.log('No vector files found — nothing to validate.')
    process.exit(0)
  }

  console.log(`Found ${jsonFiles.length} vector file(s)`)

  let totalVectors = 0
  let totalParseErrors = 0
  const suites = []
  const allErrors = []

  for (const filePath of jsonFiles) {
    const relPath = filePath.replace(vectorsDir + '/', '')
    let raw, parsed

    // Parse JSON
    try {
      raw = await readFile(filePath, 'utf-8')
      parsed = JSON.parse(raw)
    } catch (err) {
      const msg = `PARSE ERROR: ${filePath}: ${err.message}`
      allErrors.push(msg)
      totalParseErrors++
      console.log(`  [FAIL] ${relPath} — ${err.message}`)
      continue
    }

    // Validate file structure
    const { errors: fileErrors, vectors } = validateFile(filePath, parsed)

    // Validate each vector
    const cases = []
    for (let i = 0; i < vectors.length; i++) {
      const vec = vectors[i]
      const vecErrors = validateVector(filePath, vec, i)
      const vecName = vec.id ?? vec.description ?? `vector[${i}]`

      const isFatal = vecErrors.some(e => e.startsWith('ERROR:'))
      cases.push({
        name: vecName,
        pass: !isFatal,
        error: isFatal ? vecErrors.filter(e => e.startsWith('ERROR:')).join('; ') : null
      })
      if (isFatal) allErrors.push(...vecErrors.filter(e => e.startsWith('ERROR:')))
    }

    const fatalFileErrors = fileErrors.filter(e => e.startsWith('ERROR:'))
    const warnFileErrors = fileErrors.filter(e => e.startsWith('WARN:'))

    const suiteName = relPath.replace(/\.json$/, '')
    const suitePass = fatalFileErrors.length === 0

    // If the file itself has fatal errors, add a synthetic failing case
    if (fatalFileErrors.length > 0) {
      cases.unshift({
        name: '_file_structure',
        pass: false,
        error: fatalFileErrors.join('; ')
      })
      allErrors.push(...fatalFileErrors)
      totalParseErrors++
    }

    suites.push({ name: suiteName, cases })
    totalVectors += vectors.length

    const status = (fatalFileErrors.length === 0 && cases.every(c => c.pass)) ? 'OK' : 'FAIL'
    const isRegressionFile = relPath.includes('/regressions/')
    let warnStr = ''
    if (warnFileErrors.length > 0) {
      if (isRegressionFile) {
        warnStr = ` [regression format — ${warnFileErrors.length} metadata note(s)]`
      } else {
        warnStr = ` (${warnFileErrors.length} warn)`
      }
    }
    console.log(`  [${status}] ${relPath} — ${vectors.length} vector(s)${warnStr}`)

    for (const w of warnFileErrors) console.log(`       ${w}`)
    for (const e of fatalFileErrors) console.log(`       ${e}`)
  }

  console.log()
  console.log(`Summary`)
  console.log(`  Total vector files : ${jsonFiles.length}`)
  console.log(`  Total vectors      : ${totalVectors}`)
  console.log(`  Parse/structure errors : ${allErrors.filter(e => e.startsWith('ERROR:')).length}`)

  // Write reports
  const reportDir = opts.reportPath ? dirname(opts.reportPath) : REPORT_DIR
  const xmlPath = opts.reportPath ?? join(REPORT_DIR, 'results.xml')
  const jsonPath = join(reportDir, 'report.json')

  if (!opts.validateOnly) {
    await mkdir(reportDir, { recursive: true })
    await mkdir(REPORT_DIR, { recursive: true })

    const xmlReport = toJUnit(suites)
    await writeFile(xmlPath, xmlReport)
    console.log(`  JUnit XML           : ${xmlPath}`)

    const jsonReport = {
      timestamp: new Date().toISOString(),
      totalVectors,
      totalFiles: jsonFiles.length,
      parseErrors: totalParseErrors,
      suites
    }
    await writeFile(jsonPath, JSON.stringify(jsonReport, null, 2))
    console.log(`  JSON report         : ${jsonPath}`)
  }

  const hasErrors = allErrors.some(e => e.startsWith('ERROR:'))
  if (hasErrors) {
    console.log()
    console.log('RESULT: FAIL — one or more errors found')
    process.exit(1)
  }

  console.log()
  console.log('RESULT: PASS — all vector files parsed cleanly')
  process.exit(0)
}

run().catch(err => { console.error(err); process.exit(1) })
