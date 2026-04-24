import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { Signature, Transaction, PushDrop, Utils, OP, Script } from '@bsv/sdk'
import docs from './MonsterBattleTopicDocs.js'

export default class MonsterBattleTopicManager implements TopicManager {
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
      const parsedTx = Transaction.fromBEEF(beef)

      if (!Array.isArray(parsedTx.outputs) || parsedTx.outputs.length === 0) {
        throw new Error('Missing parameter: outputs')
      }

      const orderLockPrefixHex = "2097dfd76851bf465e8f715593b217714858bbe9570ff3bd5e33840a34e20ff0262102ba79df5f8ae7604a9830f03c7933028186aede0675a16f025dc4f8be8eec0382201008ce7480da41702918d1ec8e6849ba32b4d65b1e40dc669c31a1e6306b266c0000"
      const orderLockSuffixScript = Script.fromHex(orderLockPrefixHex)
      const orderLockASM = orderLockSuffixScript.toASM()

      // Inspect every output
      for (const [index, output] of parsedTx.outputs.entries()) {
        try {
          const outputASM = output.lockingScript.toASM();

          // Check for Orderlock script format first
          if (outputASM.includes(orderLockASM)) {
            console.log('[MonsterBattle] Orderlock transaction accepted');
            outputsToAdmit.push(index);
            continue;
          }

          // Check if it's a plain P2PKH (no inscription)
          if (isP2PKH(output.lockingScript)) {
            console.log('[MonsterBattle] P2PKH output ignored (wallet change)');
            continue;
          }

          console.log('[MonsterBattle] Incoming ordinal transaction')

          // Check for ordinal inscription format
          const result = checkScriptFormat(output.lockingScript)
          if (result.valid) {
            console.log(`[MonsterBattle] Ordinal transaction passed checks`)
            outputsToAdmit.push(index)
          } else {
            console.log(`[MonsterBattle] Ordinal validation failed: ${result.message}`)
          }
        } catch (err) {
          console.error(`Error processing output ${index}:`, err)
          // Continue with next output
        }
      }

      if (outputsToAdmit.length === 0) {
        throw new Error('MonsterBattle topic manager: no outputs admitted!')
      }

      console.log(`Admitted ${outputsToAdmit.length} MonsterBattle ${outputsToAdmit.length === 1 ? 'output' : 'outputs'}!`)
    } catch (err) {
      if (outputsToAdmit.length === 0 && (!previousCoins || previousCoins.length === 0)) {
        console.error('Error identifying admissible outputs:', err)
      }
    }

    // The MonsterBattle protocol never retains previous coins
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
      name: 'MonsterBattle Topic Manager',
      shortDescription: "Stores bsv-21 tokens from the MonsterBattle web game"
    }
  }
}

// Template sections for ordinal inscription validation
// Structure: formatStart (0-5) | JSON (6) | formatMiddle (7-9) | hash (10) | formatEnd (11-12) | OP_RETURN (13)
const TEMPLATES = {
  // OP_0 OP_IF 'ord' OP_1 'application/bsv-20' OP_0
  formatStart: '0063036f726451126170706c69636174696f6e2f6273762d323000',
  // OP_ENDIF OP_DUP OP_HASH160
  formatMiddle: '6876a9',
  // OP_EQUALVERIFY OP_CHECKSIG
  formatEnd: '88ac'
}

function checkScriptFormat(script: Script) {
  try {
    const chunks = script.chunks

    // Check minimum chunk count
    if (chunks.length < 14) {
      throw new Error('Insufficient chunks in script')
    }

    // Check formatStart (chunks 0-5): OP_0 OP_IF 'ord' OP_1 'application/bsv-20' OP_0
    const formatStart = new Script(chunks.slice(0, 6)).toHex()
    if (formatStart !== TEMPLATES.formatStart) {
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
    if (formatMiddle !== TEMPLATES.formatMiddle) {
      throw new Error('Malformed formatMiddle')
    }

    // Check pubkey hash data (chunk 10): should be 20 bytes
    if (!chunks[10].data || chunks[10].data.length !== 20) {
      throw new Error('Invalid pubkey hash data length')
    }

    // Check formatEnd (chunks 11-12): OP_EQUALVERIFY OP_CHECKSIG
    const formatEnd = new Script(chunks.slice(11, 13)).toHex()
    if (formatEnd !== TEMPLATES.formatEnd) {
      throw new Error('Malformed formatEnd')
    }

    // Check OP_RETURN (chunk 13)
    if (chunks[13].op !== 106) {  // 106 = 0x6a = OP_RETURN
      throw new Error('No OP_RETURN at the end')
    }

    // Validate OP_RETURN contains data
    if (!chunks[13].data || chunks[13].data.length === 0) {
      throw new Error('Missing OP_RETURN data')
    }

    return { valid: true, message: 'Script is valid' }

  } catch (error) {
    return {
      valid: false,
      message: error?.message || 'Invalid script format'
    }
  }
}

// Helper to check if script is P2PKH
function isP2PKH(script: Script): boolean {
  const chunks = script.chunks;
  if (chunks.length !== 5) return false;

  return chunks[0].op === OP.OP_DUP &&
    chunks[1].op === OP.OP_HASH160 &&
    chunks[2].data && chunks[2].data.length === 20 && // 20-byte hash
    chunks[3].op === OP.OP_EQUALVERIFY &&
    chunks[4].op === OP.OP_CHECKSIG;
}
