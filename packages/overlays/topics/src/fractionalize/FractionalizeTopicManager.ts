import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { Transaction, Script, Utils, OP } from '@bsv/sdk'

export default class FractionalizeTopicManager implements TopicManager {
  async identifyAdmissibleOutputs(beef: number[], previousCoins: number[]): Promise<AdmittanceInstructions> {
    const outputsToAdmit: number[] = []

    try {
      console.log('Fractionalize topic manager invoked')
      const parsedTx = Transaction.fromBEEF(beef)

      if (!Array.isArray(parsedTx.outputs) || parsedTx.outputs.length === 0) {
        throw new Error('Missing parameter: outputs')
      }

      for (const [index, output] of parsedTx.outputs.entries()) {
        const chunks = output.lockingScript?.chunks ?? []
        const isOrdinal = chunks.some(chunk => chunk.op === OP.OP_IF)
        const isMultiSig = chunks.some(chunk => chunk.op === OP.OP_CHECKMULTISIG)

        if (isOrdinal && isMultiSig) {
          const result = checkScriptFormat(output.lockingScript, 'server-token')
          if (result.valid) outputsToAdmit.push(index)
        }
        if (isOrdinal && !isMultiSig) {
          const result = checkScriptFormat(output.lockingScript, 'transfer-token')
          if (result.valid) outputsToAdmit.push(index)
        }
        if (isMultiSig && !isOrdinal) {
          const result = checkScriptFormat(output.lockingScript, 'payment')
          if (result.valid) outputsToAdmit.push(index)
        }
      }

      if (outputsToAdmit.length === 0) throw new Error('Fractionalize topic manager: no outputs admitted!')
    } catch (err) {
      if (outputsToAdmit.length === 0 && (!previousCoins || previousCoins.length === 0)) {
        console.error('Error identifying admissible outputs:', err)
      }
    }

    return { outputsToAdmit, coinsToRetain: [] }
  }

  async getDocumentation(): Promise<string> {
    return 'Fractionalize Topic Manager: fractionalized ownership PoC.'
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'Fractionalize Topic Manager',
      shortDescription: 'Fractionalize topic manager for the fractionalized ownership PoC'
    }
  }
}

const TEMPLATES = {
  'server-token': {
    formatStart: '0063036f726451126170706c69636174696f6e2f6273762d323000',
    formatMiddle: '686e7ea9',
    formatEnd: '886b6b516c6c52ae'
  },
  'transfer-token': {
    formatStart: '0063036f726451126170706c69636174696f6e2f6273762d323000',
    formatMiddle: '6876a9',
    formatEnd: '88ac'
  },
  payment: {
    formatStart: '6e7ea9',
    formatEnd: '886b6b516c6c52ae'
  }
}

function checkScriptFormat(script: Script, type: 'server-token' | 'transfer-token' | 'payment') {
  try {
    const chunks = script.chunks
    switch (type) {
      case 'server-token': {
        const formatStart = new Script(chunks.slice(0, 6)).toHex()
        if (formatStart !== TEMPLATES['server-token'].formatStart) throw new Error('Malformed formatStart')
        try {
          const formatJsonPayload = JSON.parse(Utils.toUTF8(chunks[6].data))
          const incorrectlyFormatted = (formatJsonPayload.p !== 'bsv-20') || !(formatJsonPayload.op === 'transfer' || formatJsonPayload.op === 'deploy+mint') || formatJsonPayload.amt === undefined || (formatJsonPayload.op === 'transfer' && !formatJsonPayload.id)
          if (incorrectlyFormatted) throw new Error('Malformed JSON payload')
        } catch (error) { throw new Error(`Invalid JSON payload: ${error.message}`) }
        const formatMiddle = new Script(chunks.slice(7, 11)).toHex()
        if (formatMiddle !== TEMPLATES['server-token'].formatMiddle) throw new Error('Malformed formatMiddle')
        if (chunks[11].data?.length !== 20) throw new Error('Invalid hash data length')
        const formatEnd = new Script(chunks.slice(12, 20)).toHex()
        if (formatEnd !== TEMPLATES['server-token'].formatEnd) throw new Error('Malformed formatEnd')
        if (chunks[20].op !== 106) throw new Error('No OP_RETURN at the end')
        if (chunks[20].data?.length === 0 || chunks[20].data == null) throw new Error('Missing OP_RETURN data')
        return { valid: true, message: 'Script is valid' }
      }
      case 'transfer-token': {
        const formatStart = new Script(chunks.slice(0, 6)).toHex()
        if (formatStart !== TEMPLATES['transfer-token'].formatStart) throw new Error('Malformed formatStart')
        try {
          const formatJsonPayload = JSON.parse(Utils.toUTF8(chunks[6].data))
          const incorrectlyFormatted = (formatJsonPayload.p !== 'bsv-20') || !(formatJsonPayload.op === 'transfer' || formatJsonPayload.op === 'deploy+mint') || formatJsonPayload.amt === undefined || (formatJsonPayload.op === 'transfer' && !formatJsonPayload.id)
          if (incorrectlyFormatted) throw new Error('Malformed JSON payload')
        } catch (error) { throw new Error(`Invalid JSON payload: ${error.message}`) }
        const formatMiddle = new Script(chunks.slice(7, 10)).toHex()
        if (formatMiddle !== TEMPLATES['transfer-token'].formatMiddle) throw new Error('Malformed formatMiddle')
        if (chunks[10].data?.length !== 20) throw new Error('Invalid pubkey hash data length')
        const formatEnd = new Script(chunks.slice(11, 13)).toHex()
        if (formatEnd !== TEMPLATES['transfer-token'].formatEnd) throw new Error('Malformed formatEnd')
        if (chunks[13].op !== 106) throw new Error('No OP_RETURN at the end')
        if (chunks[13].data?.length === 0 || chunks[13].data == null) throw new Error('Missing OP_RETURN data')
        return { valid: true, message: 'Script is valid' }
      }
      case 'payment': {
        const formatStart = new Script(chunks.slice(0, 3)).toHex()
        if (formatStart !== TEMPLATES.payment.formatStart) throw new Error('Malformed formatStart')
        if (!chunks[3].data || chunks[3].data.length !== 20) throw new Error('Invalid hash data length')
        const formatEnd = new Script(chunks.slice(4, 12)).toHex()
        if (formatEnd !== TEMPLATES.payment.formatEnd) throw new Error('Malformed formatEnd')
        return { valid: true, message: 'Script is valid' }
      }
      default:
        throw new Error(`Unknown script type: ${type}`)
    }
  } catch (error) {
    return { valid: false, message: error?.message || 'Invalid script format' }
  }
}
