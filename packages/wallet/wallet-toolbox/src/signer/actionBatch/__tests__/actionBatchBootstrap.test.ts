import { Validation } from '@bsv/sdk'
import type { StorageCapabilities } from '../../../sdk/ActionBatch.interfaces'
import { actionBatchBootstrap } from '../actionBatchBootstrap'

function capabilities (
  compactBegin?: boolean
): NonNullable<StorageCapabilities['actionBatch']> {
  return {
    version: 1,
    maxInlineBytes: 2,
    maxBlobBytes: 8,
    maxConcurrentUploads: 1,
    leaseMs: 1,
    hardLifetimeMs: 1,
    compactBegin
  }
}

describe('actionBatchBootstrap', () => {
  const action = Validation.validateCreateActionArgs({
    description: 'generic large action bootstrap',
    inputBEEF: [1, 2, 3],
    inputs: [{
      outpoint: `${'11'.repeat(32)}.0`,
      inputDescription: 'generic external input',
      unlockingScript: '51'
    }],
    outputs: [{
      satoshis: 1,
      lockingScript: '515151',
      outputDescription: 'generic large output'
    }],
    options: { noSend: true, randomizeOutputs: false }
  })

  it('removes bytes that would cross the provider inline target', () => {
    const bootstrap = actionBatchBootstrap(action, capabilities(true))

    expect(bootstrap.firstAction.inputBEEF).toBeUndefined()
    expect(bootstrap.firstAction.inputs[0].unlockingScript).toBeUndefined()
    expect(bootstrap.firstAction.inputs[0].unlockingScriptLength).toBe(1)
    expect(bootstrap.firstAction.outputs[0].lockingScript).toBe('')
    expect(bootstrap.firstActionOutputScriptLengths).toEqual([3])
    expect(JSON.stringify(bootstrap)).not.toContain('515151')
  })

  it('preserves the original request for rolling-deployment compatibility', () => {
    const bootstrap = actionBatchBootstrap(action, capabilities())

    expect(bootstrap.firstAction.inputBEEF).toEqual([1, 2, 3])
    expect(bootstrap.firstAction.inputs[0].unlockingScript).toBe('51')
    expect(bootstrap.firstAction.outputs[0].lockingScript).toBe('515151')
    expect(bootstrap.firstActionOutputScriptLengths).toBeUndefined()
  })

  it('always omits derivable bytes for format-2 providers', () => {
    const modern = {
      ...capabilities(true),
      maxInlineBytes: 1024,
      manifestVersion: 2 as const
    }
    const bootstrap = actionBatchBootstrap(action, modern)

    expect(bootstrap.firstAction.inputBEEF).toBeUndefined()
    expect(bootstrap.firstAction.outputs[0].lockingScript).toBe('')
    expect(bootstrap.firstActionOutputScriptLengths).toEqual([3])
  })
})
