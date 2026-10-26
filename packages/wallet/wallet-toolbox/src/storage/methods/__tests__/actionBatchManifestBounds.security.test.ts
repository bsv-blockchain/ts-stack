import { ACTION_BATCH_MAX_ACTIONS, validateActionBatchInlinePayload } from '../actionBatchBlobs'
import { validateManifestActions } from '../actionBatchValidation'

describe('action batch manifest bounds', () => {
  it('rejects oversized action arrays before traversing action contents', () => {
    const action = Object.defineProperty({}, 'rawTx', {
      get: () => {
        throw new Error('action traversed')
      }
    })
    const manifest = {
      actions: Array.from({ length: ACTION_BATCH_MAX_ACTIONS + 1 }, () => action),
      sendWith: []
    }

    expect(() => validateActionBatchInlinePayload(manifest as never)).toThrow(
      `no more than ${ACTION_BATCH_MAX_ACTIONS}`
    )
  })

  it('rechecks the action bound before consulting storage', async () => {
    const storage = new Proxy(
      {},
      {
        get: () => {
          throw new Error('storage consulted')
        }
      }
    )
    const manifest = {
      actions: Array.from({ length: ACTION_BATCH_MAX_ACTIONS + 1 }, () => ({})),
      sendWith: []
    }

    await expect(
      validateManifestActions(storage as never, { actionBatchId: 1 } as never, manifest as never)
    ).rejects.toThrow(`no more than ${ACTION_BATCH_MAX_ACTIONS}`)
  })
})
