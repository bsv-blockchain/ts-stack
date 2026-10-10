import { describe, expect, it } from 'vitest'
import { SDKEvidenceVerifier } from '@bsv/output-knowledge'
import { referenceContext, referenceEvidence, referenceResolver } from '../src/fixtureChain.js'

describe('reference chain', () => {
  it('checks actual Script and inclusion evidence for original, replacement and independent records', async () => {
    const verifier = new SDKEvidenceVerifier(referenceResolver)
    const context = referenceContext({
      application: 'reference',
      account: 'alice',
      access: 'public'
    })
    for (const name of ['A', 'AC', 'Q'] as const) {
      const candidate = referenceEvidence(name)
      const result = await verifier.verify(candidate, context, new AbortController().signal)
      expect(result.status).toBe('verified')
      if (result.status === 'verified') expect(result.fact.txid).toBe(candidate.evidence.txid)
    }
    await expect(
      referenceResolver.resolve(
        { ...context.view, tipHash: '00'.repeat(32) },
        new AbortController().signal
      )
    ).rejects.toThrow('Unrecognized')
  })
})
