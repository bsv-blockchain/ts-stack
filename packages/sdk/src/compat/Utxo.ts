import Transaction from '../transaction/Transaction.js'
import TransactionInput from '../transaction/TransactionInput.js'
import LockingScript from '../script/LockingScript.js'
import UnlockingScript from '../script/UnlockingScript.js'
import { compatString, uint32 } from './CompatValidation.js'

const MAX_COMPAT_UTXO_OUTPUT_INDEX = 1_000_000
const MAX_COMPAT_SCRIPT_HEX_LENGTH = 32 * 1024 * 1024
const MAX_SATOSHIS = 21e14

function utxoField(utxo: object, field: keyof JsonUtxo): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(utxo, field)
  if (descriptor == null || !('value' in descriptor)) {
    throw new TypeError(`UTXO ${field} must be an own data property`)
  }
  return descriptor.value
}

interface JsonUtxo {
  txid: string
  vout: number
  satoshis: number
  script: string
}
/**
 * @method fromUtxo
 *
 * @description
 * This function creates a transaction input from a utxo json object
 * The idea being old code that uses utxos rather than sourceTranactions can convert using this.
 *
 * @deprecated
 * This approach is made available for compatibility only. It is deprecated in favor of using sourceTransactions
 * directly. It's recommended that wallets general keep transactions which store unspent outputs in their entirety,
 * along with corresonding Merkle paths. The reason you would keep the whole transaction is such that you can prove
 * the txid, and therefore its inclusion within a specific block.
 * This helper does not authenticate the claimed txid, value, or locking script. Never use a
 * descriptor received from an untrusted party as signing/value authority; resolve and verify the
 * complete source transaction (and required chain evidence) first.
 *
 * @example
 * const i = fromUtxo({
 *   txid: '434555433eaca96dff6e71a4d02febd0dd3832e5ca4e5734623ca914522e17d5',
 *   vout: 0,
 *   script: '51',
 *   satoshis: 1234
 * }, new P2PKH().unlock(p))
 *
 * tx.addInput(i)
 *
 * @param utxo: JsonUtxo
 * @param unlockingScriptTemplate: { sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>, estimateLength: (tx: Transaction, inputIndex: number) => Promise<number> }
 * @returns
 */
export default function fromUtxo(
  utxo: JsonUtxo,
  unlockingScriptTemplate: {
    sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>
    estimateLength: (tx: Transaction, inputIndex: number) => Promise<number>
  }
): TransactionInput {
  if (utxo == null || typeof utxo !== 'object') {
    throw new TypeError('UTXO must be an object')
  }
  const prototype = Object.getPrototypeOf(utxo)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('UTXO must be a plain data object')
  }
  const txid = compatString(utxoField(utxo, 'txid'), 'UTXO txid', 64)
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) {
    throw new TypeError('UTXO txid must be 32-byte hexadecimal data')
  }
  const vout = uint32(utxoField(utxo, 'vout'), 'UTXO output index')
  if (vout > MAX_COMPAT_UTXO_OUTPUT_INDEX) {
    throw new RangeError('UTXO output index exceeds the compatibility allocation limit')
  }
  const satoshisValue = utxoField(utxo, 'satoshis')
  if (
    typeof satoshisValue !== 'number' ||
    !Number.isSafeInteger(satoshisValue) ||
    satoshisValue < 0 ||
    satoshisValue > MAX_SATOSHIS
  ) {
    throw new TypeError('UTXO satoshis must be a valid non-negative monetary amount')
  }
  const satoshis = satoshisValue
  const script = compatString(
    utxoField(utxo, 'script'),
    'UTXO locking script',
    MAX_COMPAT_SCRIPT_HEX_LENGTH
  )
  if (script.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(script)) {
    throw new TypeError('UTXO locking script must be bounded even-length hexadecimal data')
  }
  if (
    unlockingScriptTemplate == null ||
    typeof unlockingScriptTemplate.sign !== 'function' ||
    typeof unlockingScriptTemplate.estimateLength !== 'function'
  ) {
    throw new TypeError('UTXO unlocking script template is invalid')
  }
  const sourceTransaction = new Transaction(0, [], [], 0)
  sourceTransaction.outputs = Array.from(
    { length: vout + 1 },
    () => null
  ) as unknown as Transaction['outputs']
  sourceTransaction.outputs[vout] = {
    satoshis,
    lockingScript: LockingScript.fromHex(script)
  }
  return {
    sourceTransaction,
    sourceTXID: txid,
    sourceOutputIndex: vout,
    unlockingScriptTemplate,
    sequence: 0xffffffff
  }
}
