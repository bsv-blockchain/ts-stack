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

/**
 * Stateful form of the canonical selector for allocating many inputs from one
 * candidate set. It preserves exact / least-over / largest-under ordering but
 * sorts once instead of filtering and sorting the full set per input.
 */
export class CanonicalChangeSelector<T extends CanonicalFundingCandidate> {
  private readonly sorted: T[]
  private readonly allocated = new Set<number>()

  constructor (outputs: readonly T[]) {
    this.sorted = [...outputs].sort((a, b) => a.satoshis - b.satoshis || a.outputId - b.outputId)
  }

  take (targetSatoshis: number, exactSatoshis?: number): T | undefined {
    if (exactSatoshis !== undefined) {
      for (let index = this.lowerBound(exactSatoshis); index < this.sorted.length; index++) {
        const output = this.sorted[index]
        if (output.satoshis !== exactSatoshis) break
        if (!this.allocated.has(output.outputId)) return this.allocate(output)
      }
    }
    for (let index = this.lowerBound(targetSatoshis); index < this.sorted.length; index++) {
      const output = this.sorted[index]
      if (!this.allocated.has(output.outputId)) return this.allocate(output)
    }
    for (let index = this.lowerBound(targetSatoshis) - 1; index >= 0; index--) {
      const output = this.sorted[index]
      if (!this.allocated.has(output.outputId)) return this.allocate(output)
    }
    return undefined
  }

  release (outputId: number): void {
    this.allocated.delete(outputId)
  }

  private allocate (output: T): T {
    this.allocated.add(output.outputId)
    return output
  }

  private lowerBound (satoshis: number): number {
    let low = 0
    let high = this.sorted.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (this.sorted[middle].satoshis < satoshis) low = middle + 1
      else high = middle
    }
    return low
  }
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
