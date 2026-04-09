import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { Signature, Transaction, PushDrop, Utils, Script } from '@bsv/sdk'
import docs from './FractionalizeTopicDocs.js'
import { OP } from '@bsv/sdk'

/**
 * Topic manager for the simple "Fractionalize" messaging protocol.
 *
 * Each valid output must satisfy the following rules:
 * 1. There are no rules.
 */
export default class FractionalizeTopicManager implements TopicManager {
  /**
   * Identify which outputs in the supplied transaction are admissible.
   *
   * @param beef          Raw transaction encoded in BEEF format.
   * @param previousCoins Previously‑retained coins (unused by this protocol).
   */
  async identifyAdmissibleOutputs(
    beef: number[],
    previousCoins: number[]
  ): Promise<AdmittanceInstructions> {
    const outputsToAdmit: number[] = []

    try {
      console.log('Fractionalize topic manager invoked')
      const parsedTx = Transaction.fromBEEF(beef)

      if (!Array.isArray(parsedTx.outputs) || parsedTx.outputs.length === 0) {
        throw new Error('Missing parameter: outputs')
      }

      // Check each output's lockingScript and verify the format
      for (const [index, output] of parsedTx.outputs.entries()) {
        const chunks = output.lockingScript?.chunks ?? []

        // Check output type
        const isOrdinal = !!chunks.find(chunk => chunk.op === OP.OP_IF);
        const isMultiSig = !!chunks.find(chunk => chunk.op === OP.OP_CHECKMULTISIG);

        // If both true this is an ordinal token mint or server change output
        if (isOrdinal && isMultiSig) {
          const result = checkScriptFormat(output.lockingScript, "server-token")
          console.log("[FractionalizeTopicManager] Server token output detected, result: ", result.message)
          if (result.valid) {
            outputsToAdmit.push(index)
          }
        }

        // If only ordinal is true this is a token transfer to a user
        if (isOrdinal && !isMultiSig) {
          const result = checkScriptFormat(output.lockingScript, "transfer-token")
          console.log("[FractionalizeTopicManager] Server transfer token output detected, result: ", result.message)
          if (result.valid) {
            outputsToAdmit.push(index)
          }
        }

        // If only multisig is true this is a payment output
        if (isMultiSig && !isOrdinal) {
          const result = checkScriptFormat(output.lockingScript, "payment")
          console.log("[FractionalizeTopicManager] Server payment output detected, result: ", result.message)
          if (result.valid) {
            outputsToAdmit.push(index)
          }
        }
      }

      if (outputsToAdmit.length === 0) {
        throw new Error('Fractionalize topic manager: no outputs admitted!')
      }

    } catch (err) {
      if (outputsToAdmit.length === 0 && (!previousCoins || previousCoins.length === 0)) {
        console.error('Error identifying admissible outputs:', err)
      }
    }

    // The Fractionalize protocol never retains previous coins
    return {
      outputsToAdmit,
      coinsToRetain: []
    }
  }

  /**
   * Get the documentation associated with this topic manager
   * @returns A promise that resolves to a string containing the documentation
   */
  async getDocumentation(): Promise<string> {
    return docs
  }

  /**
   * Get metadata about the topic manager
   * @returns A promise that resolves to an object containing metadata
   */
  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'Fractionalize Topic Manager',
      shortDescription: "Fractionalize topic manager for the fractionalized ownership PoC"
    }
  }
}

// Template sections for comprehensive script validation
const TEMPLATES = {
  "server-token": {
    // OP_0 OP_IF 'ord' OP_1 'application/bsv-20' OP_0
    formatStart: '0063036f726451126170706c69636174696f6e2f6273762d323000',
    // OP_ENDIF OP_2DUP OP_CAT OP_HASH160
    formatMiddle: '686e7ea9',
    // OP_EQUALVERIFY OP_TOALTSTACK OP_TOALTSTACK OP_1 OP_FROMALTSTACK OP_FROMALTSTACK OP_2 OP_CHECKMULTISIG
    formatEnd: '886b6b516c6c52ae'
  },
  "transfer-token": {
    // OP_0 OP_IF 'ord' OP_1 'application/bsv-20' OP_0
    formatStart: '0063036f726451126170706c69636174696f6e2f6273762d323000',
    // OP_ENDIF OP_DUP OP_HASH160
    formatMiddle: '6876a9',
    // OP_EQUALVERIFY OP_CHECKSIG
    formatEnd: '88ac'
  },
  "payment": {
    // OP_2DUP OP_CAT OP_HASH160
    formatStart: '6e7ea9',
    // OP_EQUALVERIFY OP_TOALTSTACK OP_TOALTSTACK OP_1 OP_FROMALTSTACK OP_FROMALTSTACK OP_2 OP_CHECKMULTISIG
    formatEnd: '886b6b516c6c52ae'
  }
}

function checkScriptFormat(script: Script, type: "server-token" | "transfer-token" | "payment") {
  try {
    const chunks = script.chunks

    switch (type) {
      case "server-token": {
        // Server token: ordinal inscription + multisig
        // Structure: formatStart (0-5) | JSON (6) | formatMiddle (7-10) | hash (11) | formatEnd (12-19) | OP_RETURN (20)

        // Check formatStart (chunks 0-5): OP_0 OP_IF 'ord' OP_1 'application/bsv-20' OP_0
        const formatStart = new Script(chunks.slice(0, 6)).toHex()
        if (formatStart !== TEMPLATES['server-token'].formatStart) {
          throw new Error('Malformed formatStart')
        }

        // Validate JSON payload (chunk 6)
        try {
          const formatJsonPayload = JSON.parse(Utils.toUTF8(chunks[6].data))
          const incorrectlyFormatted =
            (formatJsonPayload.p !== 'bsv-20') ||
            !(formatJsonPayload.op === 'transfer' || formatJsonPayload.op === 'deploy+mint') ||
            formatJsonPayload.amt === undefined ||
            (formatJsonPayload.op === 'transfer' && !formatJsonPayload.id)

          if (incorrectlyFormatted) {
            throw new Error('Malformed JSON payload')
          }
        } catch (error) {
          throw new Error(`Invalid JSON payload: ${error.message}`)
        }

        // Check formatMiddle (chunks 7-10): OP_ENDIF OP_2DUP OP_CAT OP_HASH160
        const formatMiddle = new Script(chunks.slice(7, 11)).toHex()
        if (formatMiddle !== TEMPLATES['server-token'].formatMiddle) {
          throw new Error('Malformed formatMiddle')
        }

        // Check hash data (chunk 11): should be 20 bytes
        if (!chunks[11].data || chunks[11].data.length !== 20) {
          throw new Error('Invalid hash data length')
        }

        // Check formatEnd (chunks 12-19): multisig ending
        const formatEnd = new Script(chunks.slice(12, 20)).toHex()
        if (formatEnd !== TEMPLATES['server-token'].formatEnd) {
          throw new Error('Malformed formatEnd')
        }

        // Check OP_RETURN (chunk 20)
        if (chunks[20].op !== 106) {  // 106 = 0x6a = OP_RETURN
          throw new Error('No OP_RETURN at the end')
        }

        // Validate OP_RETURN contains data (original mint txid)
        if (!chunks[20].data || chunks[20].data.length === 0) {
          throw new Error('Missing OP_RETURN data')
        }

        return { valid: true, message: 'Script is valid' }
      }

      case "transfer-token": {
        // Transfer token: ordinal inscription + P2PKH
        // Structure: formatStart (0-5) | JSON (6) | formatMiddle (7-9) | hash (10) | formatEnd (11-12) | OP_RETURN (13)

        // Check formatStart (chunks 0-5)
        const formatStart = new Script(chunks.slice(0, 6)).toHex()
        if (formatStart !== TEMPLATES['transfer-token'].formatStart) {
          throw new Error('Malformed formatStart')
        }

        // Validate JSON payload (chunk 6)
        try {
          const formatJsonPayload = JSON.parse(Utils.toUTF8(chunks[6].data))
          const incorrectlyFormatted =
            (formatJsonPayload.p !== 'bsv-20') ||
            !(formatJsonPayload.op === 'transfer' || formatJsonPayload.op === 'deploy+mint') ||
            formatJsonPayload.amt === undefined ||
            (formatJsonPayload.op === 'transfer' && !formatJsonPayload.id)

          if (incorrectlyFormatted) {
            throw new Error('Malformed JSON payload')
          }
        } catch (error) {
          throw new Error(`Invalid JSON payload: ${error.message}`)
        }

        // Check formatMiddle (chunks 7-9): OP_ENDIF OP_DUP OP_HASH160
        const formatMiddle = new Script(chunks.slice(7, 10)).toHex()
        if (formatMiddle !== TEMPLATES['transfer-token'].formatMiddle) {
          throw new Error('Malformed formatMiddle')
        }

        // Check pubkey hash data (chunk 10): should be 20 bytes
        if (!chunks[10].data || chunks[10].data.length !== 20) {
          throw new Error('Invalid pubkey hash data length')
        }

        // Check formatEnd (chunks 11-12): OP_EQUALVERIFY OP_CHECKSIG
        const formatEnd = new Script(chunks.slice(11, 13)).toHex()
        if (formatEnd !== TEMPLATES['transfer-token'].formatEnd) {
          throw new Error('Malformed formatEnd')
        }

        // Check OP_RETURN (chunk 13)
        if (chunks[13].op !== 106) {  // 106 = 0x6a = OP_RETURN
          throw new Error('No OP_RETURN at the end')
        }

        // Validate OP_RETURN contains data (original mint txid)
        if (!chunks[13].data || chunks[13].data.length === 0) {
          throw new Error('Missing OP_RETURN data')
        }

        return { valid: true, message: 'Script is valid' }
      }

      case "payment": {
        // Payment script: just multisig, no ordinal inscription
        // Structure: formatStart (0-2) | hash (3) | formatEnd (4-11)

        // Check formatStart (chunks 0-2): OP_2DUP OP_CAT OP_HASH160
        const formatStart = new Script(chunks.slice(0, 3)).toHex()
        if (formatStart !== TEMPLATES['payment'].formatStart) {
          throw new Error('Malformed formatStart')
        }

        // Check hash data (chunk 3): should be 20 bytes
        if (!chunks[3].data || chunks[3].data.length !== 20) {
          throw new Error('Invalid hash data length')
        }

        // Check formatEnd (chunks 4-11): multisig ending
        const formatEnd = new Script(chunks.slice(4, 12)).toHex()
        if (formatEnd !== TEMPLATES['payment'].formatEnd) {
          throw new Error('Malformed formatEnd')
        }

        return { valid: true, message: 'Script is valid' }
      }

      default:
        throw new Error(`Unknown script type: ${type}`)
    }

  } catch (error) {
    return {
      valid: false,
      message: error?.message || 'Invalid script format'
    }
  }
}