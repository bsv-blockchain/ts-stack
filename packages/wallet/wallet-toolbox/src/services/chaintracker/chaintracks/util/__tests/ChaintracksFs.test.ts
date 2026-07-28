import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ChaintracksAppendableFile, ChaintracksWritableFile } from '../ChaintracksFs'

describe('Chaintracks filesystem writers', () => {
  let temporaryDirectory: string

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'chaintracks-fs-'))
  })

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true })
  })

  test('creates parent folders once and appends through both writer modes', async () => {
    const path = join(temporaryDirectory, 'nested', 'headers.bin')
    await mkdir(join(temporaryDirectory, 'nested'))
    const writable = await ChaintracksWritableFile.openAsWritable(path)
    await expect(writable.append(Uint8Array.from([1, 2]))).rejects.toThrow('Method not implemented.')
    await writable.close()

    const appendable = await ChaintracksAppendableFile.openAsAppendable(path)
    await appendable.append(Uint8Array.from([4]))
    await appendable.append(Uint8Array.from([5]))
    await appendable.close()

    await expect(readFile(path)).resolves.toEqual(Buffer.from([4, 5]))
  })
})
