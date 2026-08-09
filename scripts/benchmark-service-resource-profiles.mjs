#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const manifestPath = `${root}/governance/service-resource-profiles.json`
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

function sampleItem(targetBytes, index) {
  const fixed = JSON.stringify({
    id: index,
    created_at: '2026-08-04T00:00:00.000Z',
    body: ''
  }).length
  return {
    id: index,
    created_at: '2026-08-04T00:00:00.000Z',
    body: 'x'.repeat(Math.max(0, targetBytes - fixed))
  }
}

function runChild(serviceName, profileName) {
  const service = manifest.services[serviceName]
  const values = service.values[profileName]
  global.gc?.()
  const before = process.memoryUsage()
  const items = Array.from({ length: values.maxItems }, (_, index) =>
    sampleItem(service.representativeItemBytes, index)
  )
  const json = JSON.stringify({ status: 'success', items })
  const authenticatedBytes = Buffer.from(json, 'utf8')
  const reparsed = JSON.parse(json)
  const after = process.memoryUsage()
  if (
    reparsed.items.length !== values.maxItems ||
    authenticatedBytes.length !== Buffer.byteLength(json)
  ) {
    throw new Error('benchmark integrity check failed')
  }
  const representativeResponseBytes = authenticatedBytes.length
  const modeledParallelBytes =
    representativeResponseBytes * values.concurrency * manifest.measurement.duplicationFactor
  process.stdout.write(
    JSON.stringify({
      service: serviceName,
      profile: profileName,
      items: values.maxItems,
      representativeResponseBytes,
      responseCapBytes: values.maxResponseBytes,
      measuredHeapDeltaBytes: Math.max(0, after.heapUsed - before.heapUsed),
      measuredRssDeltaBytes: Math.max(0, after.rss - before.rss),
      modeledParallelBytes,
      minimumMemoryMiB: manifest.profiles[profileName].minimumMemoryMiB,
      withinResponseCap: representativeResponseBytes <= values.maxResponseBytes,
      withinModeledMemory:
        modeledParallelBytes <= manifest.profiles[profileName].minimumMemoryMiB * 1024 * 1024 * 0.8
    })
  )
}

function runParent() {
  const results = []
  for (const [serviceName, service] of Object.entries(manifest.services)) {
    for (const profileName of Object.keys(service.values)) {
      const heapMiB = Math.max(
        256,
        Math.floor(manifest.profiles[profileName].minimumMemoryMiB * 0.75)
      )
      const child = spawnSync(
        process.execPath,
        [
          '--expose-gc',
          `--max-old-space-size=${heapMiB}`,
          fileURLToPath(import.meta.url),
          '--child',
          serviceName,
          profileName
        ],
        { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
      )
      if (child.status !== 0) {
        process.stderr.write(child.stderr)
        throw new Error(`profile benchmark failed for ${serviceName}/${profileName}`)
      }
      results.push(JSON.parse(child.stdout))
    }
  }
  const failedCaps = results.filter(result => !result.withinResponseCap)
  if (failedCaps.length > 0) {
    const failedProfiles = failedCaps.map(r => `${r.service}/${r.profile}`).join(', ')
    throw new Error(`representative pages exceed response caps: ${failedProfiles}`)
  }
  const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    duplicationFactor: manifest.measurement.duplicationFactor,
    results
  }
  if (process.argv.includes('--check')) {
    process.stdout.write(`Validated ${results.length} service resource-profile scenarios.\n`)
  } else {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  }
}

if (process.argv[2] === '--child') runChild(process.argv[3], process.argv[4])
else runParent()
