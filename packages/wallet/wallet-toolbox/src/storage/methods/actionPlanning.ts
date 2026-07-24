import { Random } from '@bsv/sdk'

export interface CanonicalFundingCandidate {
  outputId: number
  satoshis: number
}

/** Pure exact / least-over / largest-under change selection policy. */
export function selectCanonicalChange<T extends CanonicalFundingCandidate> (
  outputs: T[],
  targetSatoshis: number,
  exactSatoshis?: number
): T | undefined {
  if (exactSatoshis !== undefined) {
    const exact = outputs
      .filter(output => output.satoshis === exactSatoshis)
      .sort((a, b) => a.outputId - b.outputId)[0]
    if (exact != null) return exact
  }
  const over = outputs
    .filter(output => output.satoshis >= targetSatoshis)
    .sort((a, b) => a.satoshis - b.satoshis || a.outputId - b.outputId)[0]
  if (over != null) return over
  return outputs
    .filter(output => output.satoshis < targetSatoshis)
    .sort((a, b) => b.satoshis - a.satoshis || b.outputId - a.outputId)[0]
}

export function repeatableRandom (randomVals?: number[]): () => number {
  const values = [...(randomVals ?? [])]
  return () => {
    if (values.length > 0) {
      const value = values.shift() ?? 0
      values.push(value)
      return value
    }
    const bytes = Random(4)
    return (((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0) / 0x100000000
  }
}

/** Pure Fisher-Yates vout assignment shared by legacy and batch planning. */
export function randomizeOutputVouts<T extends { vout: number }> (outputs: T[], randomVals?: number[]): void {
  const nextRandom = repeatableRandom(randomVals)
  const vouts = Array.from({ length: outputs.length }, (_, index) => index)
  for (let current = vouts.length; current > 0; current--) {
    const randomIndex = Math.floor(nextRandom() * current)
    ;[vouts[current - 1], vouts[randomIndex]] = [vouts[randomIndex], vouts[current - 1]]
  }
  for (let index = 0; index < outputs.length; index++) outputs[index].vout = vouts[index]
}
