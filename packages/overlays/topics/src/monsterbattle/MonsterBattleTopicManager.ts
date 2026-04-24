import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { Transaction, PushDrop, Utils, OP, Script } from '@bsv/sdk'

export default class MonsterBattleTopicManager implements TopicManager {
  async identifyAdmissibleOutputs(beef: number[], previousCoins: number[]): Promise<AdmittanceInstructions> {
    const outputsToAdmit: number[] = []

    try {
      const parsedTx = Transaction.fromBEEF(beef)

      if (!Array.isArray(parsedTx.outputs) || parsedTx.outputs.length === 0) {
        throw new Error('Missing parameter: outputs')
      }

      const orderLockPrefixHex = '2097dfd76851bf465e8f715593b217714858bbe9570ff3bd5e33840a34e20ff0262102ba79df5f8ae7604a9830f03c7933028186aede0675a16f025dc4f8be8eec0382201008ce7480da41702918d1ec8e6849ba32b4d65b1e40dc669c31a1e6306b266c0000'
      const orderLockSuffixScript = Script.fromHex(orderLockPrefixHex)
      const orderLockASM = orderLockSuffixScript.toASM()

      for (const [index, output] of parsedTx.outputs.entries()) {
        try {
          const outputASM = output.lockingScript.toASM()
          if (outputASM.includes(orderLockASM)) {
            outputsToAdmit.push(index)
            continue
          }
          if (isP2PKH(output.lockingScript)) continue

          const result = checkScriptFormat(output.lockingScript)
          if (result.valid) outputsToAdmit.push(index)
        } catch (err) {
          console.error(`Error processing output ${index}:`, err)
        }
      }

      if (outputsToAdmit.length === 0) throw new Error('MonsterBattle topic manager: no outputs admitted!')
      console.log(`Admitted ${outputsToAdmit.length} MonsterBattle output(s)!`)
    } catch (err) {
      if (outputsToAdmit.length === 0 && (!previousCoins || previousCoins.length === 0)) {
        console.error('Error identifying admissible outputs:', err)
      }
    }

    return { outputsToAdmit, coinsToRetain: [] }
  }

  async getDocumentation(): Promise<string> {
    return 'MonsterBattle Topic Manager: stores bsv-21 tokens from the MonsterBattle web game.'
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'MonsterBattle Topic Manager',
      shortDescription: 'Stores bsv-21 tokens from the MonsterBattle web game'
    }
  }
}

const TEMPLATES = {
  formatStart: '0063036f726451126170706c69636174696f6e2f6273762d323000',
  formatMiddle: '6876a9',
  formatEnd: '88ac'
}

function checkScriptFormat(script: Script) {
  try {
    const chunks = script.chunks
    if (chunks.length < 14) throw new Error('Insufficient chunks in script')

    const formatStart = new Script(chunks.slice(0, 6)).toHex()
    if (formatStart !== TEMPLATES.formatStart) throw new Error('Malformed formatStart')

    try {
      const formatJsonPayload = JSON.parse(Utils.toUTF8(chunks[6].data))
      const incorrectlyFormatted = (formatJsonPayload.p !== 'bsv-20') || !(formatJsonPayload.op === 'transfer' || formatJsonPayload.op === 'deploy+mint') || formatJsonPayload.amt === undefined || (formatJsonPayload.op === 'transfer' && !formatJsonPayload.id)
      if (incorrectlyFormatted) throw new Error('Malformed JSON payload')
    } catch (error) { throw new Error(`Invalid JSON payload: ${error.message}`) }

    const formatMiddle = new Script(chunks.slice(7, 10)).toHex()
    if (formatMiddle !== TEMPLATES.formatMiddle) throw new Error('Malformed formatMiddle')
    if (!chunks[10].data || chunks[10].data.length !== 20) throw new Error('Invalid pubkey hash data length')

    const formatEnd = new Script(chunks.slice(11, 13)).toHex()
    if (formatEnd !== TEMPLATES.formatEnd) throw new Error('Malformed formatEnd')
    if (chunks[13].op !== 106) throw new Error('No OP_RETURN at the end')
    if (!chunks[13].data || chunks[13].data.length === 0) throw new Error('Missing OP_RETURN data')

    return { valid: true, message: 'Script is valid' }
  } catch (error) {
    return { valid: false, message: error?.message || 'Invalid script format' }
  }
}

function isP2PKH(script: Script): boolean {
  const chunks = script.chunks
  if (chunks.length !== 5) return false
  return chunks[0].op === OP.OP_DUP &&
    chunks[1].op === OP.OP_HASH160 &&
    chunks[2].data && chunks[2].data.length === 20 &&
    chunks[3].op === OP.OP_EQUALVERIFY &&
    chunks[4].op === OP.OP_CHECKSIG
}
