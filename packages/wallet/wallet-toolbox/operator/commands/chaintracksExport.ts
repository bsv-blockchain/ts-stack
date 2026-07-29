import fs from 'node:fs'

import type { Chain } from '../../out/src'
import { OperatorCommand, OperatorEvidence } from '../contracts'
import { explicitOutputPath, optionInteger, optionString } from '../safety'

const DEFAULT_CDN_BASE_URL = 'https://cdn.projectbabbage.com/blockheaders'

function parseChain(value: string): Chain {
  if (value !== 'main' && value !== 'test') {
    throw new Error('Operator option "--chain" must be "main" or "test"')
  }
  return value
}

export const chaintracksExportCommand: OperatorCommand = {
  name: 'chaintracks-export',
  description: 'Export bulk Chaintracks headers into an explicit local artifact directory.',
  allowedOptions: new Set(['cdn-base-url', 'chain', 'headers-per-file', 'output']),
  plan(options) {
    const chain = parseChain(optionString(options, 'chain', 'test'))
    const output = explicitOutputPath(options, 'output')
    const headersPerFile = optionInteger(options, 'headers-per-file', 100_000, {
      min: 100,
      max: 1_000_000
    })
    const cdnBaseUrl = optionString(options, 'cdn-base-url', DEFAULT_CDN_BASE_URL)
    const parsedUrl = new URL(cdnBaseUrl)
    if (parsedUrl.protocol !== 'https:' || parsedUrl.username !== '' || parsedUrl.password !== '') {
      throw new Error('Operator option "--cdn-base-url" must use HTTPS without embedded credentials')
    }
    return {
      command: 'chaintracks-export',
      description: 'Download and export canonical bulk block-header artifacts.',
      effect: 'local-write',
      requiresProductionApproval: chain === 'main',
      parameters: {
        chain,
        output,
        headersPerFile,
        cdnBaseUrl: parsedUrl.toString().replace(/\/$/, '')
      }
    }
  },
  async execute(_options, plan): Promise<OperatorEvidence> {
    const { Chaintracks, ChaintracksFs, createDefaultNoDbChaintracksOptions } = await import('../../out/src/index.js')
    const startedAt = new Date().toISOString()
    const chain = plan.parameters.chain as Chain
    const output = plan.parameters.output as string
    const headersPerFile = plan.parameters.headersPerFile as number
    const cdnBaseUrl = plan.parameters.cdnBaseUrl as string

    if (fs.existsSync(output) && fs.readdirSync(output).length > 0) {
      throw new Error(`Refusing to write into non-empty output directory "${output}"`)
    }
    fs.mkdirSync(output, { recursive: true })

    const chaintracks = new Chaintracks(createDefaultNoDbChaintracksOptions(chain))
    try {
      await chaintracks.makeAvailable()
      const tip = await chaintracks.findChainTipHeader()
      await chaintracks.exportBulkHeaders(output, ChaintracksFs, cdnBaseUrl, headersPerFile)
      const artifacts = fs.readdirSync(output).sort()
      if (artifacts.length === 0) {
        throw new Error('Chaintracks export completed without producing an artifact')
      }
      return {
        command: 'chaintracks-export',
        startedAt,
        completedAt: new Date().toISOString(),
        result: {
          chain,
          output,
          tipHeight: tip.height,
          tipHash: tip.hash,
          artifactCount: artifacts.length
        }
      }
    } finally {
      await chaintracks.destroy()
    }
  }
}
