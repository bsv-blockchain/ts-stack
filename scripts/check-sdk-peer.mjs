#!/usr/bin/env node
/**
 * check-sdk-peer.mjs
 *
 * Enforces the @bsv/sdk singleton contract for published libraries:
 *
 *   - A non-private package under packages/** MUST NOT declare @bsv/sdk as a
 *     regular `dependency`. @bsv/sdk re-exposes classes with private fields,
 *     so TypeScript types them nominally; two copies from two node_modules
 *     trees become incompatible types for downstream consumers. Published
 *     libraries must declare it as a `peerDependency` (and a devDependency for
 *     their own build/tests). Apps/servers (infra/**, private packages) are the
 *     ones that PROVIDE the single copy, so they keep it as a dependency.
 *   - Any @bsv/sdk peerDependency must use a wide range (^ / >=), never an exact
 *     pin — exact pins across libs fan out into duplicate installs.
 *
 * Exit code 1 if any violation is found (CI guard).
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const files = execSync(
  "find packages -name package.json -not -path '*/node_modules/*' -not -path '*/dist/*'",
  { cwd: ROOT, encoding: 'utf8' }
).trim().split('\n').filter(Boolean)

const violations = []

for (const rel of files) {
  let pkg
  try {
    pkg = JSON.parse(readFileSync(resolve(ROOT, rel), 'utf8'))
  } catch {
    continue
  }
  if (pkg.private === true) continue
  if (pkg.name === '@bsv/sdk') continue

  const asDep = pkg.dependencies?.['@bsv/sdk']
  if (asDep !== undefined) {
    violations.push(
      `${pkg.name} (${rel}): @bsv/sdk is a regular "dependency" ("${asDep}"). ` +
      'Move it to peerDependencies: { "@bsv/sdk": "^2" } + devDependencies: { "@bsv/sdk": "workspace:^" }.'
    )
  }

  const asPeer = pkg.peerDependencies?.['@bsv/sdk']
  if (asPeer !== undefined && !/^(\^|>=|~|\*)/.test(asPeer.trim())) {
    violations.push(
      `${pkg.name} (${rel}): @bsv/sdk peerDependency "${asPeer}" is exact-pinned. Use a wide range like "^2".`
    )
  }
}

if (violations.length > 0) {
  console.error('@bsv/sdk peer-dependency contract violations:\n')
  for (const v of violations) console.error(`  - ${v}`)
  console.error(`\n${violations.length} violation(s). See scripts/check-sdk-peer.mjs for the rationale.`)
  process.exit(1)
}

console.log(`@bsv/sdk peer contract OK: scanned ${files.length} packages/** manifests, no violations.`)
