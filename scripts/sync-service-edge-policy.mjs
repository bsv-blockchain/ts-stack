#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

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

const canonical = fs.readFileSync(path.join(repositoryRoot, canonicalPath), 'utf8')
const checkOnly = process.argv.includes('--check')

let drift = false
for (const relativePath of synchronizedPaths) {
  const absolutePath = path.join(repositoryRoot, relativePath)
  const current = fs.existsSync(absolutePath)
    ? fs.readFileSync(absolutePath, 'utf8')
    : ''
  if (current === canonical) continue
  drift = true
  if (!checkOnly) {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(absolutePath, canonical)
    console.log(`Synchronized ${relativePath}`)
  } else {
    console.error(`${relativePath} differs from ${canonicalPath}`)
  }
}

if (checkOnly && drift) {
  console.error('Run `pnpm sync:service-edge-policy` and commit the synchronized files.')
  process.exitCode = 1
} else if (checkOnly) {
  console.log(`Service edge policy is synchronized across ${synchronizedPaths.length + 1} contexts.`)
}
