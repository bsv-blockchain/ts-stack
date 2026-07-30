#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { readUtf8FileIfExists, writeUtf8FileAtomic } from './file-system.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const policy = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, 'governance/service-edge-browser-policy.json'), 'utf8')
)
const canonicalPath = policy.canonicalSource
const synchronizedPaths = policy.synchronizedSources
const canonicalTestPath = policy.canonicalTest
const synchronizedTestPaths = policy.synchronizedTests

const canonical = fs.readFileSync(path.join(repositoryRoot, canonicalPath), 'utf8')
const canonicalTest = fs.readFileSync(path.join(repositoryRoot, canonicalTestPath), 'utf8')
const checkOnly = process.argv.includes('--check')

let drift = false
const policyErrors = []
if (policy.schemaVersion !== 1 || policy.defaultContract?.corsMode !== 'public') {
  policyErrors.push('service edge browser policy must preserve the version 1 public default')
}
if (
  policy.defaultContract?.allowOrigin !== '*' ||
  policy.defaultContract?.allowCredentials !== false ||
  policy.defaultContract?.opaqueOrigin !== 'allowed' ||
  policy.defaultContract?.cspControlsCors !== false
) {
  policyErrors.push('service edge browser policy changed the public/no-credentials contract')
}
for (const testName of policy.requiredContractTests ?? []) {
  if (!canonicalTest.includes(`it('${testName}'`)) {
    policyErrors.push(`canonical edge contract is missing ${JSON.stringify(testName)}`)
  }
}
for (const integration of policy.integrations ?? []) {
  const integrationPath = path.join(repositoryRoot, integration.integration)
  const sourcePath = path.join(repositoryRoot, integration.source)
  if (!fs.existsSync(sourcePath)) policyErrors.push(`${integration.service} source does not exist`)
  if (!fs.existsSync(integrationPath)) {
    policyErrors.push(`${integration.service} integration does not exist`)
    continue
  }
  const source = fs.readFileSync(integrationPath, 'utf8')
  for (const fragment of ['corsPolicy(', 'securityHeaders(', integration.environmentPrefix]) {
    if (!source.includes(fragment)) {
      policyErrors.push(`${integration.service} integration is missing ${JSON.stringify(fragment)}`)
    }
  }
}
for (const [sourcePath, source, relativePath] of [
  ...synchronizedPaths.map(relativePath => [canonicalPath, canonical, relativePath]),
  ...synchronizedTestPaths.map(relativePath => [canonicalTestPath, canonicalTest, relativePath])
]) {
  const absolutePath = path.join(repositoryRoot, relativePath)
  const current = readUtf8FileIfExists(absolutePath) ?? ''
  if (current === source) continue
  drift = true
  if (!checkOnly) {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    writeUtf8FileAtomic(absolutePath, source)
    console.log(`Synchronized ${relativePath}`)
  } else {
    console.error(`${relativePath} differs from ${sourcePath}`)
  }
}

if (policyErrors.length > 0) {
  for (const error of policyErrors) console.error(error)
  process.exitCode = 1
} else if (checkOnly && drift) {
  console.error('Run `pnpm sync:service-edge-policy` and commit the synchronized files.')
  process.exitCode = 1
} else if (checkOnly) {
  console.log(
    `Service edge policy is synchronized across ${synchronizedPaths.length + 1} contexts; ` +
      `the contract test is synchronized across ${synchronizedTestPaths.length + 1} contexts; ` +
      `${policy.integrations.length} public service integrations preserve the browser contract.`
  )
}
