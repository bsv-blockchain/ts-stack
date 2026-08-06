#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { readUtf8FileIfExists, writeUtf8FileAtomic } from './file-system.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const policyPath = path.join(repositoryRoot, 'governance/service-runtime-copy-policy.json')
const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'))
const checkOnly = process.argv.includes('--check')

if (policy.schemaVersion !== 1 || !Array.isArray(policy.copies) || policy.copies.length === 0) {
  throw new Error('service runtime copy policy must declare at least one version 1 copy set')
}

let drift = false
let synchronizedCount = 0
for (const copySet of policy.copies) {
  const canonicalPath = path.join(repositoryRoot, copySet.canonicalSource)
  const canonical = fs.readFileSync(canonicalPath, 'utf8')
  for (const relativePath of copySet.synchronizedSources) {
    synchronizedCount += 1
    const absolutePath = path.join(repositoryRoot, relativePath)
    if (readUtf8FileIfExists(absolutePath) === canonical) continue
    drift = true
    if (checkOnly) {
      console.error(`${relativePath} differs from ${copySet.canonicalSource}`)
      continue
    }
    writeUtf8FileAtomic(absolutePath, canonical)
    console.log(`Synchronized ${relativePath}`)
  }
}

if (checkOnly && drift) {
  console.error('Run `pnpm sync:service-runtime-copies` and commit the synchronized files.')
  process.exitCode = 1
} else if (checkOnly) {
  console.log(`Service runtime sources are synchronized across ${synchronizedCount} copies.`)
}
