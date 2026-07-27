import { Utils } from '@bsv/sdk'
import { errorMessage } from './errorMessage.js'

interface Bsv20Payload {
  p?: unknown
  op?: unknown
  amt?: unknown
  id?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function assertValidBsv20Payload(data: number[] | undefined): void {
  try {
    if (data === undefined) throw new Error('Missing JSON payload')

    const payload: unknown = JSON.parse(Utils.toUTF8(data))
    if (!isRecord(payload)) throw new Error('Malformed JSON payload')

    const { p, op, amt, id } = payload as Bsv20Payload
    const isSupportedOperation = op === 'transfer' || op === 'deploy+mint'
    const isTransferWithoutId = op === 'transfer' && !id
    if (p !== 'bsv-20' || !isSupportedOperation || amt === undefined || isTransferWithoutId) {
      throw new Error('Malformed JSON payload')
    }
  } catch (error) {
    throw new Error(`Invalid JSON payload: ${errorMessage(error)}`)
  }
}
