import { Utils as SdkUtils } from '@bsv/sdk'

export interface TxScriptOffsets {
  inputs: { vin: number; offset: number; length: number }[]
  outputs: { vout: number; offset: number; length: number }[]
}

export function parseTxScriptOffsets(rawTx: number[]): TxScriptOffsets {
  const br = new SdkUtils.Reader(rawTx)
  const inputs: { vin: number; offset: number; length: number }[] = []
  const outputs: { vout: number; offset: number; length: number }[] = []

  br.pos += 4 // version
  const inputsLength = br.readVarIntNum()
  for (let i = 0; i < inputsLength; i++) {
    br.pos += 36 // txid and vout
    const scriptLength = br.readVarIntNum()
    inputs.push({ vin: i, offset: br.pos, length: scriptLength })
    br.pos += scriptLength + 4 // script and sequence
  }
  const outputsLength = br.readVarIntNum()
  for (let i = 0; i < outputsLength; i++) {
    br.pos += 8 // satoshis
    const scriptLength = br.readVarIntNum()
    outputs.push({ vout: i, offset: br.pos, length: scriptLength })
    br.pos += scriptLength
  }
  return { inputs, outputs }
}
