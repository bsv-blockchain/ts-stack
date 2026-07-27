#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { readUtf8FileIfExists, writeUtf8FileAtomic } from './file-system.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const canonicalPath = 'infra/wab/src/security/rateLimitPolicy.ts'
const synchronizedPaths = [
  'infra/uhrp-server-basic/src/security/rateLimitPolicy.ts',
  'infra/uhrp-server-cloud-bucket/src/security/rateLimitPolicy.ts',
  'infra/message-box-server/src/security/rateLimitPolicy.ts'
]

const canonical = fs.readFileSync(path.join(repositoryRoot, canonicalPath), 'utf8')
const checkOnly = process.argv.includes('--check')

let drift = false
for (const relativePath of synchronizedPaths) {
  const absolutePath = path.join(repositoryRoot, relativePath)
  const current = readUtf8FileIfExists(absolutePath) ?? ''
  if (current === canonical) continue
  drift = true
  if (!checkOnly) {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    writeUtf8FileAtomic(absolutePath, canonical)
    console.log(`Synchronized ${relativePath}`)
  } else {
    console.error(`${relativePath} differs from ${canonicalPath}`)
  }
}

if (checkOnly && drift) {
  console.error('Run `pnpm sync:service-rate-limit-policy` and commit the synchronized files.')
  process.exitCode = 1
} else if (checkOnly) {
  console.log(
    `Service rate-limit policy is synchronized across ${synchronizedPaths.length + 1} deployable contexts.`
  )
}
