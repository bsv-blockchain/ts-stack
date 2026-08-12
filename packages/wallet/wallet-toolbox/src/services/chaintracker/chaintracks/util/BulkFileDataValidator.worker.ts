import { parentPort } from 'node:worker_threads'
import type {
  BulkFileDataValidationRequest,
  BulkFileDataValidationResult,
  BulkFileDataValidatorApi
} from '../Api/BulkFileDataValidatorApi'
import { InlineBulkFileDataValidator } from './InlineBulkFileDataValidator'

export interface BulkFileDataValidatorWorkerRequest {
  id: number
  request: Omit<BulkFileDataValidationRequest, 'data'> & { data: ArrayBuffer }
}

interface WorkerSuccess {
  id: number
  ok: true
  result: Omit<BulkFileDataValidationResult, 'data'> & { data: ArrayBuffer }
}

interface WorkerFailure {
  id: number
  ok: false
  error: { name: string; message: string; stack?: string } | string
  data: ArrayBuffer
}

export interface BulkFileDataValidatorWorkerPort {
  on(event: 'message', listener: (message: BulkFileDataValidatorWorkerRequest) => void | Promise<void>): unknown
  postMessage(message: WorkerSuccess | WorkerFailure, transferList: ArrayBuffer[]): unknown
}

export function createBulkFileDataValidatorWorkerHandler(
  port: Pick<BulkFileDataValidatorWorkerPort, 'postMessage'>,
  validator: BulkFileDataValidatorApi = new InlineBulkFileDataValidator()
): (message: BulkFileDataValidatorWorkerRequest) => Promise<void> {
  return async ({ id, request }) => {
    const data = new Uint8Array(request.data)
    try {
      const result = await validator.validate({ ...request, data })
      const resultBuffer = result.data.buffer as ArrayBuffer
      port.postMessage({ id, ok: true, result: { ...result, data: resultBuffer } }, [resultBuffer])
    } catch (error) {
      port.postMessage(
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
  }
}

export function attachBulkFileDataValidatorWorker(
  port: BulkFileDataValidatorWorkerPort,
  validator: BulkFileDataValidatorApi = new InlineBulkFileDataValidator()
): void {
  port.on('message', createBulkFileDataValidatorWorkerHandler(port, validator))
}

if (parentPort != null) attachBulkFileDataValidatorWorker(parentPort)
