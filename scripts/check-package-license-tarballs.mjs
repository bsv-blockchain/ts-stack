#!/usr/bin/env node

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import {
  LICENSE_FILE,
  REPOSITORY_ROOT
} from './package-license-policy.mjs'

const registry = JSON.parse(
  fs.readFileSync(
    path.join(REPOSITORY_ROOT, 'governance/repository-health/projects.json'),
    'utf8'
  )
)
const packages = registry.projects.filter(project => project.release === 'npm-oidc')
const expectedLicenseSize = fs.statSync(
  path.join(REPOSITORY_ROOT, LICENSE_FILE)
).size
const execFileAsync = promisify(execFile)

async function verifyPackage(project) {
  const projectDirectory = path.join(REPOSITORY_ROOT, project.path)
  let result
  try {
    const { stdout } = await execFileAsync(
      'npm',
      ['pack', '--dry-run', '--json', '--ignore-scripts'],
      {
        cwd: projectDirectory,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120_000
      }
    )
    result = JSON.parse(
      stdout
    )
  } catch (error) {
    return [
      `${project.path} could not be dry-packed: ` +
      `${error.stderr?.toString().trim() || error.message}`
    ]
  }

  if (!Array.isArray(result) || result.length !== 1) {
    return [`${project.path} returned an unexpected npm pack result`]
  }
  const packed = result[0]
  const errors = []
  if (packed.name !== project.name) {
    errors.push(
      `${project.path} packed as ${JSON.stringify(packed.name)}, expected ` +
      JSON.stringify(project.name)
    )
  }
  const licenses = packed.files?.filter(file => file.path === LICENSE_FILE) ?? []
  if (licenses.length !== 1) {
    errors.push(
      `${project.path} tarball must contain exactly one root ${LICENSE_FILE}`
    )
  } else if (licenses[0].size !== expectedLicenseSize) {
    errors.push(
      `${project.path} tarball ${LICENSE_FILE} has size ${licenses[0].size}, ` +
      `expected ${expectedLicenseSize}`
    )
  }
  return errors
}

async function mapWithConcurrency(items, concurrency, operation) {
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await operation(items[index])
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      () => worker()
    )
  )
  return results
}

const errors = (
  await mapWithConcurrency(packages, 8, verifyPackage)
).flat()
if (packages.length !== 30) {
  errors.push(`Expected 30 public npm packages, found ${packages.length}`)
}

if (errors.length > 0) {
  console.error(errors.join('\n'))
  process.exitCode = 1
} else {
  console.log(
    `Verified ${packages.length} public package tarballs include the canonical ` +
    `${LICENSE_FILE}.`
  )
}
