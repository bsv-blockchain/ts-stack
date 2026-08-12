import { parentPort } from 'node:worker_threads'
import type { BulkFileDataValidationRequest } from '../Api/BulkFileDataValidatorApi'
import { InlineBulkFileDataValidator } from './InlineBulkFileDataValidator'

interface WorkerRequest {
  id: number
  request: Omit<BulkFileDataValidationRequest, 'data'> & { data: ArrayBuffer }
}

if (parentPort == null) throw new Error('BulkFileDataValidator worker requires a parent port')

const validator = new InlineBulkFileDataValidator()

parentPort.on('message', async ({ id, request }: WorkerRequest) => {
  const data = new Uint8Array(request.data)
  try {
    const result = await validator.validate({ ...request, data })
    const resultBuffer = result.data.buffer as ArrayBuffer
    parentPort!.postMessage({ id, ok: true, result: { ...result, data: resultBuffer } }, [resultBuffer])
  } catch (error) {
    parentPort!.postMessage(
      {
        id,
        ok: false,
        error:
          error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
        data: data.buffer as ArrayBuffer
      },
      [data.buffer as ArrayBuffer]
    )
  }
})
