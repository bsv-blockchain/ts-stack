import { Hash } from '@bsv/sdk'
import * as path from 'node:path'
import { asArray, asString } from '../../../../../utility/utilityHelpers.noBuffer'
import { BulkFileDataValidationError } from '../../Api/BulkFileDataValidatorApi'
import { convertBitsToWork, deserializeBlockHeader, genesisBuffer } from '../blockHeaderUtilities'
import {
  attachBulkFileDataValidatorWorker,
  createBulkFileDataValidatorWorkerHandler,
  type BulkFileDataValidatorWorkerPort,
  type BulkFileDataValidatorWorkerRequest
} from '../BulkFileDataValidator.worker'
import { NodeBulkFileDataValidator } from '../NodeBulkFileDataValidator'

function request(data: Uint8Array) {
  const header = deserializeBlockHeader(data, 0)
  return {
    fileName: 'mainNet_0.headers',
    data,
    count: 1,
    fileHash: asString(Hash.sha256(asArray(data)), 'base64'),
    firstHeight: 0,
    prevHash: '00'.repeat(32),
    prevChainWork: '00'.repeat(32),
    lastHash: header.hash,
    lastChainWork: convertBitsToWork(header.bits),
    chain: 'main' as const
  }
}

function workerRequest(id: number, data: Uint8Array): BulkFileDataValidatorWorkerRequest {
  return {
    id,
    request: { ...request(data), data: data.buffer as ArrayBuffer }
  }
}

function recordingWorkerPort() {
  const messages: Array<{ message: unknown; transferList: ArrayBuffer[] }> = []
  const listeners: Array<(message: BulkFileDataValidatorWorkerRequest) => void | Promise<void>> = []
  const port: BulkFileDataValidatorWorkerPort = {
    on: (_event, listener) => listeners.push(listener),
    postMessage: (message, transferList) => messages.push({ message, transferList })
  }
  return { listeners, messages, port }
}

const compiledWorkerPath = path.join(
  process.cwd(),
  'out/src/services/chaintracker/chaintracks/util/BulkFileDataValidator.worker.js'
)
const lifecycleWorkerPath = path.join(__dirname, 'fixtures', 'slowValidationWorker.cjs')

describe('NodeBulkFileDataValidator', () => {
  test('directly covers worker protocol success and attachment', async () => {
    const { listeners, messages, port } = recordingWorkerPort()
    attachBulkFileDataValidatorWorker(port)
    expect(listeners).toHaveLength(1)

    const data = Uint8Array.from(genesisBuffer('main'))
    await listeners[0](workerRequest(17, data))

    expect(messages).toHaveLength(1)
    expect(messages[0].message).toMatchObject({
      id: 17,
      ok: true,
      result: { data: expect.any(ArrayBuffer), lastHeaderHash: request(data).lastHash }
    })
    expect(messages[0].transferList).toHaveLength(1)
  })

  test('creates a worker handler with the portable validator by default', async () => {
    const { messages, port } = recordingWorkerPort()
    const handler = createBulkFileDataValidatorWorkerHandler(port)
    const data = Uint8Array.from(genesisBuffer('main'))

    await handler(workerRequest(19, data))

    expect(messages[0].message).toMatchObject({ id: 19, ok: true })
  })

  test.each([
    [new Error('worker validation failed'), { name: 'Error', message: 'worker validation failed' }],
    ['non-error rejection', 'non-error rejection']
  ])('directly covers worker protocol failure payloads', async (failure, expectedError) => {
    const { messages, port } = recordingWorkerPort()
    const handler = createBulkFileDataValidatorWorkerHandler(port, {
      validate: () => Promise.reject(failure)
    })
    const data = Uint8Array.from(genesisBuffer('main'))

    await handler(workerRequest(23, data))

    expect(messages).toHaveLength(1)
    expect(messages[0].message).toMatchObject({
      id: 23,
      ok: false,
      error: expectedError,
      data: expect.any(ArrayBuffer)
    })
    expect(messages[0].transferList).toHaveLength(1)
  })

  test('validates and returns an immutable object through the real worker boundary', async () => {
    const validator = new NodeBulkFileDataValidator({
      workerPath: compiledWorkerPath
    })
    const data = Uint8Array.from(genesisBuffer('main'))
    try {
      const result = await validator.validate(request(data))
      expect(result.data).toEqual(Uint8Array.from(genesisBuffer('main')))
      expect(result.lastHeaderHash).toBe(request(result.data).lastHash)
      expect(validator.getStats()).toMatchObject({ submitted: 1, completed: 1, failed: 0 })
    } finally {
      await validator.destroy()
    }
  })

  test('returns rejected bytes for quarantine without weakening validation', async () => {
    const validator = new NodeBulkFileDataValidator({
      workerPath: compiledWorkerPath
    })
    const valid = Uint8Array.from(genesisBuffer('main'))
    const invalid = valid.slice()
    invalid[0] ^= 1
    try {
      await expect(validator.validate({ ...request(valid), data: invalid })).rejects.toMatchObject({
        name: 'BulkFileDataValidationError',
        data: expect.any(Uint8Array)
      } satisfies Partial<BulkFileDataValidationError>)
    } finally {
      await validator.destroy()
    }
  })

  test('keeps the main event loop responsive and rejects work beyond the bounded queue', async () => {
    const validator = new NodeBulkFileDataValidator({
      maxWorkers: 1,
      maxQueue: 1,
      workerPath: lifecycleWorkerPath
    })
    const slowRequest = { ...request(Uint8Array.from(genesisBuffer('main'))), fileName: 'slow.headers' }
    const first = validator.validate(slowRequest)
    const second = validator.validate(slowRequest)
    const timer = new Promise<'timer'>(resolve => setTimeout(() => resolve('timer'), 10))
    try {
      await expect(validator.validate(slowRequest)).rejects.toThrow('validation queue is full')
      await expect(Promise.race([timer, first.then(() => 'worker' as const)])).resolves.toBe('timer')
      await expect(Promise.all([first, second])).resolves.toHaveLength(2)
      expect(validator.getStats()).toMatchObject({ submitted: 2, completed: 2, rejected: 1 })
    } finally {
      await validator.destroy()
    }
  })

  test.each([
    ['maxWorkers', { maxWorkers: 0 }],
    ['maxQueue', { maxQueue: Number.NaN }],
    ['taskTimeoutMsecs', { taskTimeoutMsecs: 1.5 }]
  ])('rejects invalid %s before starting the worker pool', (_name, options) => {
    expect(() => new NodeBulkFileDataValidator(options)).toThrow('must be a positive safe integer')
  })

  test('copies sliced buffers and rejects use after idempotent destruction', async () => {
    const validator = new NodeBulkFileDataValidator({ workerPath: compiledWorkerPath })
    const padded = new Uint8Array(genesisBuffer('main').length + 2)
    padded.set(genesisBuffer('main'), 1)
    const sliced = padded.subarray(1, padded.length - 1)

    await expect(validator.validate(request(sliced))).resolves.toMatchObject({
      data: Uint8Array.from(genesisBuffer('main'))
    })
    await validator.destroy()
    await validator.destroy()
    await expect(validator.validate(request(Uint8Array.from(genesisBuffer('main'))))).rejects.toThrow(
      'has been destroyed'
    )
  })

  test('rejects both active and queued work when destroyed', async () => {
    const validator = new NodeBulkFileDataValidator({ maxQueue: 2, workerPath: lifecycleWorkerPath })
    const slowRequest = { ...request(Uint8Array.from(genesisBuffer('main'))), fileName: 'slow.headers' }
    const active = validator.validate(slowRequest)
    const queued = validator.validate(slowRequest)
    const activeResult = expect(active).rejects.toThrow('validator was destroyed')
    const queuedResult = expect(queued).rejects.toThrow('validator was destroyed')

    await validator.destroy()

    await activeResult
    await queuedResult
    expect(validator.getStats()).toMatchObject({ inFlight: 0, queued: 0 })
  })

  test('times out a task, restarts the worker, and remains usable', async () => {
    const validator = new NodeBulkFileDataValidator({
      taskTimeoutMsecs: 500,
      workerPath: lifecycleWorkerPath
    })
    const data = Uint8Array.from(genesisBuffer('main'))

    try {
      await expect(validator.validate({ ...request(data), fileName: 'timeout.headers' })).rejects.toThrow(
        'validation exceeded 500ms'
      )
      await expect(validator.validate(request(Uint8Array.from(genesisBuffer('main'))))).resolves.toMatchObject({
        lastHeaderHash: request(data).lastHash
      })
      expect(validator.getStats()).toMatchObject({ completed: 1, failed: 1, workerRestarts: 1 })
    } finally {
      await validator.destroy()
    }
  })

  test('recovers after an unexpected worker exit and ignores stale responses', async () => {
    const validator = new NodeBulkFileDataValidator({ workerPath: lifecycleWorkerPath })
    const data = Uint8Array.from(genesisBuffer('main'))

    try {
      await expect(validator.validate({ ...request(data), fileName: 'exit.headers' })).rejects.toThrow(
        'exited unexpectedly with code 17'
      )
      await expect(
        validator.validate({ ...request(Uint8Array.from(genesisBuffer('main'))), fileName: 'mismatch.headers' })
      ).resolves.toMatchObject({ lastHeaderHash: request(data).lastHash })
      expect(validator.getStats()).toMatchObject({ completed: 1, failed: 1, workerRestarts: 1 })
    } finally {
      await validator.destroy()
    }
  })

  test('propagates worker errors and supports all failure payload shapes', async () => {
    const validator = new NodeBulkFileDataValidator({ workerPath: lifecycleWorkerPath })
    const data = Uint8Array.from(genesisBuffer('main'))

    try {
      await expect(validator.validate({ ...request(data), fileName: 'error.headers' })).rejects.toThrow(
        'worker fixture failure'
      )
      await expect(
        validator.validate({ ...request(Uint8Array.from(genesisBuffer('main'))), fileName: 'failure-string.headers' })
      ).rejects.toThrow('string failure')
      await expect(
        validator.validate({ ...request(Uint8Array.from(genesisBuffer('main'))), fileName: 'failure-empty.headers' })
      ).rejects.toThrow('Validation failed')
      expect(validator.getStats()).toMatchObject({ failed: 3, workerRestarts: 1 })
    } finally {
      await validator.destroy()
    }
  })
})
