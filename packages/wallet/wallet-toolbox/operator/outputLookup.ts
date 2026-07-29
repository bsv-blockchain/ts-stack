import type { StorageReaderWriter } from '../out/src/storage/StorageReaderWriter'

type OutputReader = Pick<StorageReaderWriter, 'findOutputById'>

export async function findOutputWithoutScript(storage: OutputReader, outputId: number) {
  return await storage.findOutputById(outputId, undefined, true)
}
