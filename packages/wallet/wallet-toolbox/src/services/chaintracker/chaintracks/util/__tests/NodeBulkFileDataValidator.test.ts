import { Hash } from '@bsv/sdk'
import * as path from 'node:path'
import { asArray, asString } from '../../../../../utility/utilityHelpers.noBuffer'
import { BulkFileDataValidationError } from '../../Api/BulkFileDataValidatorApi'
import { convertBitsToWork, deserializeBlockHeader, genesisBuffer } from '../blockHeaderUtilities'
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

describe('NodeBulkFileDataValidator', () => {
  test('validates and returns an immutable object through the real worker boundary', async () => {
    const validator = new NodeBulkFileDataValidator({
      workerPath: path.join(
        process.cwd(),
        'out/src/services/chaintracker/chaintracks/util/BulkFileDataValidator.worker.js'
      )
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
      workerPath: path.join(
        process.cwd(),
        'out/src/services/chaintracker/chaintracks/util/BulkFileDataValidator.worker.js'
      )
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
      workerPath: path.join(__dirname, 'fixtures', 'slowValidationWorker.cjs')
    })
    const first = validator.validate(request(Uint8Array.from(genesisBuffer('main'))))
    const second = validator.validate(request(Uint8Array.from(genesisBuffer('main'))))
    const timer = new Promise<'timer'>(resolve => setTimeout(() => resolve('timer'), 10))
    try {
      await expect(validator.validate(request(Uint8Array.from(genesisBuffer('main'))))).rejects.toThrow(
        'validation queue is full'
      )
      await expect(Promise.race([timer, first.then(() => 'worker' as const)])).resolves.toBe('timer')
      await expect(Promise.all([first, second])).resolves.toHaveLength(2)
      expect(validator.getStats()).toMatchObject({ submitted: 2, completed: 2, rejected: 1 })
    } finally {
      await validator.destroy()
    }
  })
})
