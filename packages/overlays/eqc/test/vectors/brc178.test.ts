import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Utils } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'

import { verifyBRC77 } from '../../src/protocol/brc77.js'
import { buildVectors } from './build.js'

// Vitest runs from the package root.
const FILE = join(process.cwd(), 'test', 'vectors', 'brc178-vectors.json')

describe('BRC-178 test vectors', () => {
  it('match what this implementation computes', async () => {
    const built = await buildVectors()
    // Regenerate with BRC178_WRITE_VECTORS=1 after a deliberate protocol change.
    if (process.env.BRC178_WRITE_VECTORS === '1') {
      writeFileSync(FILE, `${JSON.stringify(built, null, 2)}\n`)
    }
    expect(built).toEqual(JSON.parse(readFileSync(FILE, 'utf8')))
  })

  it('carry signatures that verify as published', () => {
    const vectors = JSON.parse(readFileSync(FILE, 'utf8'))
    const { signer, attestation, delivery } = vectors.signatures
    for (const signed of [attestation, delivery]) {
      const result = verifyBRC77(
        Utils.toArray(signed.preimageUtf8, 'utf8'),
        Utils.toArray(signed.brc77Hex, 'hex')
      )
      expect(result).toEqual({ valid: true, signer })
    }
  })
})
