import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ChaintracksAppendableFile,
  ChaintracksFs,
  ChaintracksReadableFile,
  ChaintracksWritableFile
} from '../ChaintracksFs'

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
    const writable = await ChaintracksWritableFile.openAsWritable(path)
    await writable.append(Uint8Array.from([1, 2]))
    await writable.close()

    const appendable = await ChaintracksAppendableFile.openAsAppendable(path)
    await appendable.append(Uint8Array.from([4]))
    await appendable.append(Uint8Array.from([5]))
    await appendable.close()

    await expect(readFile(path)).resolves.toEqual(Buffer.from([1, 2, 4, 5]))

    const readable = await ChaintracksReadableFile.openAsReadable(path)
    await expect(readable.read(2, 1)).resolves.toEqual(Uint8Array.from([2, 4]))
    await expect(readable.read(0, 0)).resolves.toHaveLength(0)
    await expect(readable.read(-1, 0)).rejects.toThrow('non-negative safe offset')
    await expect(readable.read(100_001 * 80, 0)).rejects.toThrow('at most')
    await readable.close()
  })

  test('bounds direct whole-file reads and writes before allocation or persistence', async () => {
    const path = join(temporaryDirectory, 'whole-file.bin')
    await expect(ChaintracksFs.writeFile(path, new Uint8Array(100_000 * 80 + 1))).rejects.toThrow('at most')

    await writeFile(path, new Uint8Array(100_000 * 80 + 1))
    await expect(ChaintracksFs.readFile(path)).rejects.toThrow('at most')
  })
})
