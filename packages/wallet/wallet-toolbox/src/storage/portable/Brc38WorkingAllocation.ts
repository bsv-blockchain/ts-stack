import { SnapshotWorkingAllocationLimitError } from '../snapshot/SnapshotWorkingAllocationLimitError'

const issuer = Object.freeze({})
function size(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Invalid BRC-38 working allocation')
  return value
}

/** Live resource accounting only. This object cannot admit a source, schema,
 * transaction, profile or semantic result. The actual owner must still check
 * those independently. Reservations count simultaneously reachable component
 * allowances, including idle indexes; a new pass cannot renew the ceiling.
 * This models explicit JavaScript allocations, not VM or SQLite resident RSS. */
export class Brc38WorkingAllocation {
  #used = 0
  readonly #maximum: number
  constructor(maximum: number) {
    this.#maximum = size(maximum)
    if (maximum < 1 || maximum > 16777216) throw new RangeError('Invalid original BRC-38 working ceiling')
  }
  get maximum(): number {
    return this.#maximum
  }
  get used(): number {
    return this.#used
  }
  private change(delta: number): void {
    if (!Number.isSafeInteger(delta)) throw new RangeError('Invalid BRC-38 working allocation change')
    const next = this.#used + delta
    if (!Number.isSafeInteger(next) || next < 0) throw new RangeError('Invalid BRC-38 working allocation balance')
    if (next > this.#maximum)
      throw new SnapshotWorkingAllocationLimitError(
        'BRC-38 components exceed their original combined working allocation'
      )
    this.#used = next
  }
  claim(bytes: number): Brc38WorkingCharge {
    size(bytes)
    this.change(bytes)
    return new Brc38WorkingCharge(issuer, delta => this.change(delta), bytes)
  }
}

export class Brc38WorkingCharge {
  #closed = false
  constructor(
    token: object,
    private readonly adjust: (delta: number) => void,
    private bytes: number
  ) {
    if (token !== issuer) throw new Error('BRC-38 working reservation requires its actual resource owner')
  }
  resize(bytes: number): void {
    size(bytes)
    if (this.#closed) throw new Error('BRC-38 working reservation is closed')
    this.adjust(bytes - this.bytes)
    this.bytes = bytes
  }
  close(): void {
    if (!this.#closed) {
      this.adjust(-this.bytes)
      this.#closed = true
    }
  }
}

export function brc38WorkingAllocation(value: Brc38WorkingAllocation | undefined): Brc38WorkingAllocation | undefined {
  if (value === undefined) return undefined
  if (!(value instanceof Brc38WorkingAllocation) || !Number.isSafeInteger(value.used))
    throw new TypeError('BRC-38 working allocation requires its actual resource owner')
  return value
}
