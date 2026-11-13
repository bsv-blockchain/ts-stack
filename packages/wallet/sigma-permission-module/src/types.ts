import type Point from '@bsv/sdk/primitives/Point'

export type SigmaOperation = 'key' | 'schnorr' | 'dleq' | 'or'

export type ParsedPlaintext =
  | { operation: 'key'; H?: Point }
  | { operation: 'schnorr'; ctx: number[] }
  | { operation: 'dleq'; H: Point; ctx: number[] }
  | { operation: 'or'; n: number; index: number; others: Point[]; ctx: number[] }
