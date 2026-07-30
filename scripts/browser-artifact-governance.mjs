#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url))
const POLICY_PATH = path.join(REPOSITORY_ROOT, 'governance/browser-artifact-policy.json')
const PROJECTS_PATH = path.join(REPOSITORY_ROOT, 'governance/repository-health/projects.json')

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

export function validateBrowserArtifactGovernance(root = REPOSITORY_ROOT) {
  const policy = readJson(path.join(root, path.relative(REPOSITORY_ROOT, POLICY_PATH)))
  const registry = readJson(path.join(root, path.relative(REPOSITORY_ROOT, PROJECTS_PATH)))
  const errors = []
  if (policy.schemaVersion !== 1) errors.push('browser artifact policy schemaVersion must be 1')
  if (!Number.isSafeInteger(policy.reportRetentionDays) || policy.reportRetentionDays < 1) {
    errors.push('browser artifact report retention must be positive')
  }
  if (!isNonEmptyString(policy.growthPolicy)) errors.push('browser growth policy is required')

  const governedNames = new Set(
    registry.projects
      .filter(project => (project.consumerProfiles ?? []).includes('browser-bundler'))
      .map(project => project.name)
  )
  const policyNames = new Set(policy.packages.map(item => item.name))
  for (const name of governedNames) {
    if (!policyNames.has(name)) errors.push(`missing browser artifact disposition for ${name}`)
  }
  for (const entry of policy.packages) {
    if (!governedNames.has(entry.name)) {
      errors.push(`stale browser artifact disposition for ${entry.name}`)
    }
    const manifest = readJson(path.join(root, entry.path, 'package.json'))
    const budget = readJson(path.join(root, entry.budget))
    if (manifest.name !== entry.name) errors.push(`${entry.path} does not identify ${entry.name}`)
    if (budget.profile !== 'browser') errors.push(`${entry.budget} is not a browser budget`)
    if (budget.entry !== undefined && budget.entry !== entry.entry) {
      errors.push(`${entry.name} policy entry differs from its browser budget`)
    }
    if (!isNonEmptyString(entry.splittingDisposition)) {
      errors.push(`${entry.name} requires an optional-adapter splitting disposition`)
    }
  }
  return errors
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const errors = validateBrowserArtifactGovernance()
  if (errors.length > 0) {
    console.error(errors.join('\n'))
    process.exitCode = 1
  } else {
    console.log('Browser artifact growth and optional-adapter dispositions are complete.')
  }
}
