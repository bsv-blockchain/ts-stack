import { outputU64, OutputProtocolError } from '@bsv/sdk'

export const position = (value: string): string => outputU64(value).toString(16).padStart(16, '0')
export function decimal(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 16 || /[^0-9a-f]/.test(value))
    throw new OutputProtocolError('reset-required', 'Invalid lookup index sequence')
  return BigInt('0x' + value).toString()
}
export const bytes = (value: string): number => new TextEncoder().encode(value).length
