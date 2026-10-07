import type { EngineOutputReader } from '@bsv/overlay-topics'

interface StoredOutput {
  txid: string
  outputIndex: number
  outputScript: number[]
  satoshis: number
}

/** The overlay engine storage calls used to repair a Mandala owner index. */
export interface MandalaEngineStorage {
  findOutput: (
    txid: string,
    outputIndex: number,
    topic?: string,
    spent?: boolean
  ) => Promise<StoredOutput | null>
  findUTXOsForTopic: (topic: string) => Promise<StoredOutput[]>
}

const byOutpoint = (
  left: { txid: string; outputIndex: number },
  right: { txid: string; outputIndex: number }
): number => {
  if (left.txid < right.txid) return -1
  if (left.txid > right.txid) return 1
  return left.outputIndex - right.outputIndex
}

/**
 * Reads admitted outputs after the engine exists. Topic registration happens
 * before `configureEngine`, so each call resolves storage then.
 */
export function createMandalaEngineOutputs(
  resolve: () => MandalaEngineStorage
): EngineOutputReader {
  return {
    findAdmittedOutput: async (txid, outputIndex, topic) => {
      const output = await resolve().findOutput(txid, outputIndex, topic, false)
      if (output === null) return null
      return { lockingScript: output.outputScript, satoshis: output.satoshis }
    },
    listUnspentAdmittedOutputs: async (topic, after, limit) => {
      const ordered = (await resolve().findUTXOsForTopic(topic))
        .map(output => ({ txid: output.txid, outputIndex: output.outputIndex }))
        .sort(byOutpoint)
      const page =
        after === null
          ? ordered
          : ordered.filter(
              output =>
                output.txid > after.txid ||
                (output.txid === after.txid && output.outputIndex > after.outputIndex)
            )
      return page.slice(0, limit)
    }
  }
}
