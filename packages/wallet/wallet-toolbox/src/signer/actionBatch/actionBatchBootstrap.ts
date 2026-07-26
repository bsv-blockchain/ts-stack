import { Validation } from '@bsv/sdk'
import type {
  BeginActionBatchArgs,
  StorageCapabilities
} from '../../sdk/ActionBatch.interfaces'

type ActionBatchBootstrap = Omit<BeginActionBatchArgs, 'batchId'>

/**
 * Removes large values that are uploaded through the content-addressed commit
 * path later. Older version-1 providers receive the original request unless
 * they explicitly advertise compact bootstrap support.
 */
export function actionBatchBootstrap (
  args: Validation.ValidCreateActionArgs,
  capabilities: NonNullable<StorageCapabilities['actionBatch']>
): ActionBatchBootstrap {
  const firstAction = { ...args, logger: undefined }
  if (capabilities.compactBegin !== true) return { firstAction }

  const scriptBytes = args.outputs.reduce(
    (sum, output) => sum + output.lockingScript.length / 2,
    0
  ) + args.inputs.reduce(
    (sum, input) => sum + (input.unlockingScript?.length ?? 0) / 2,
    0
  )
  const totalBytes = scriptBytes + (args.inputBEEF?.length ?? 0)
  if (totalBytes <= capabilities.maxInlineBytes) return { firstAction }

  return {
    firstAction: {
      ...firstAction,
      inputBEEF: undefined,
      inputs: firstAction.inputs.map(input => ({
        ...input,
        unlockingScript: undefined
      })),
      outputs: firstAction.outputs.map(output => ({
        ...output,
        lockingScript: ''
      }))
    },
    firstActionOutputScriptLengths: firstAction.outputs.map(
      output => output.lockingScript.length / 2
    )
  }
}
