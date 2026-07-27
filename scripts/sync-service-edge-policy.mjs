#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { readUtf8FileIfExists, writeUtf8FileAtomic } from './file-system.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const canonicalPath = 'infra/wab/src/security/edgePolicy.ts'
const synchronizedPaths = [
  'infra/uhrp-server-basic/src/security/edgePolicy.ts',
  'infra/uhrp-server-cloud-bucket/src/security/edgePolicy.ts',
  'infra/message-box-server/src/security/edgePolicy.ts',
  'infra/chaintracks-server/src/security/edgePolicy.ts',
  'packages/overlays/overlay-express/src/security/edgePolicy.ts',
  'packages/wallet/wallet-toolbox/src/storage/remoting/edgePolicy.ts'
]
const canonicalTestPath = 'infra/wab/src/security/edgePolicy.test.ts'
const synchronizedTestPaths = [
  'packages/overlays/overlay-express/src/security/edgePolicy.test.ts',
  'packages/wallet/wallet-toolbox/src/storage/remoting/edgePolicy.test.ts'
]

const canonical = fs.readFileSync(path.join(repositoryRoot, canonicalPath), 'utf8')
const canonicalTest = fs.readFileSync(path.join(repositoryRoot, canonicalTestPath), 'utf8')
const checkOnly = process.argv.includes('--check')

let drift = false
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

if (checkOnly && drift) {
  console.error('Run `pnpm sync:service-edge-policy` and commit the synchronized files.')
  process.exitCode = 1
} else if (checkOnly) {
  console.log(
    `Service edge policy is synchronized across ${synchronizedPaths.length + 1} contexts; ` +
      `the contract test is synchronized across ${synchronizedTestPaths.length + 1} contexts.`
  )
}
