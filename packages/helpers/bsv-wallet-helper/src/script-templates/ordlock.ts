import { Writer, fromBase58Check, toArray, toHex as bytesToHex } from '@bsv/sdk/primitives/utils'
import {
  BigNumber,
  LockingScript,
  OP,
  Script,
  ScriptTemplate,
  Transaction,
  UnlockingScript,
  WalletInterface,
  WalletProtocol
} from '@bsv/sdk'
import { calculatePreimage } from '../utils/createPreimage'
import P2PKH from './p2pkh'
import {
  OrdLockCancelUnlockParams,
  OrdLockLockParams,
  OrdLockPurchaseUnlockParams,
  OrdLockUnlockParams
} from './types'

// This script is represented as fixed prefix/suffix blobs in hex.
// The cancel/purchase conditions are triggered by a final flag push:
// - cancel: OP_1 (wallet signature + pubkey)
// - purchase: OP_0 (outputs blob + preimage)

const OLOCK_PREFIX =
  '2097dfd76851bf465e8f715593b217714858bbe9570ff3bd5e33840a34e20ff0262102ba79df5f8ae7604a9830f03c7933028186aede0675a16f025dc4f8be8eec0382201008ce7480da41702918d1ec8e6849ba32b4d65b1e40dc669c31a1e6306b266c0000'

const OLOCK_SUFFIX =
  '615179547a75537a537a537a0079537a75527a527a7575615579008763567901c161517957795779210ac407f0e4bd44bfc207355a778b046225a7068fc59ee7eda43ad905aadbffc800206c266b30e6a1319c66dc401e5bd6b432ba49688eecd118297041da8074ce081059795679615679aa0079610079517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e01007e81517a75615779567956795679567961537956795479577995939521414136d08c5ed2bf3ba048afe6dcaebafeffffffffffffffffffffffffffffff00517951796151795179970079009f63007952799367007968517a75517a75517a7561527a75517a517951795296a0630079527994527a75517a6853798277527982775379012080517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e01205279947f7754537993527993013051797e527e54797e58797e527e53797e52797e57797e0079517a75517a75517a75517a75517a75517a75517a75517a75517a75517a75517a75517a75517a756100795779ac517a75517a75517a75517a75517a75517a75517a75517a75517a7561517a75517a756169587951797e58797eaa577961007982775179517958947f7551790128947f77517a75517a75618777777777777777777767557951876351795779a9876957795779ac777777777777777767006868'

// String -> hex helper
const toHex = (str: string): string => {
  return bytesToHex(toArray(str))
}

const MAX_SATOSHIS = 21e14
const MAX_JSON_DEPTH = 64
const MAX_JSON_NODES = 100000

function requireSatoshis(value: unknown, name: string, minimum = 0): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > MAX_SATOSHIS
  ) {
    throw new Error(`${name} must be a safe integer between ${minimum} and ${MAX_SATOSHIS}`)
  }
  return value as number
}

function validateJsonData(value: unknown, name: string): void {
  const ancestors = new WeakSet<object>()
  let nodes = 0

  const visit = (current: unknown, path: string, depth: number): void => {
    nodes++
    if (nodes > MAX_JSON_NODES) throw new Error(`${name} exceeds ${MAX_JSON_NODES} JSON values`)
    if (depth > MAX_JSON_DEPTH) throw new Error(`${name} exceeds maximum JSON depth`)
    if (current === null || typeof current === 'string' || typeof current === 'boolean') {
      return
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new Error(`${path} must be a finite JSON number`)
      return
    }
    if (typeof current !== 'object') {
      throw new Error(`${path} must contain only JSON data`)
    }
    const object = current as object
    const prototype = Object.getPrototypeOf(object)
    if (!Array.isArray(object) && prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} must be a plain JSON object or array`)
    }
    if (ancestors.has(object)) throw new Error(`${path} must not contain a cycle`)
    ancestors.add(object)
    const descriptors = Object.getOwnPropertyDescriptors(object)
    if (Array.isArray(object)) {
      for (let index = 0; index < object.length; index++) {
        if (!Object.prototype.hasOwnProperty.call(descriptors, String(index))) {
          throw new Error(`${path} must not contain sparse arrays`)
        }
      }
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (key === 'length' && Array.isArray(object)) continue
      if (!('value' in descriptor) || descriptor.get != null || descriptor.set != null) {
        throw new Error(`${path}.${key} must be a data property`)
      }
      if (descriptor.enumerable) visit(descriptor.value, `${path}.${key}`, depth + 1)
    }
    if (Object.getOwnPropertySymbols(object).length > 0) {
      throw new Error(`${path} must not contain symbol properties`)
    }
    ancestors.delete(object)
  }

  visit(value, name, 0)
}

// Validate the lock parameters
function validateLockParams(params: OrdLockLockParams): void {
  if (!params || typeof params !== 'object') {
    throw new Error('params is required')
  }
  if (!params.ordAddress || typeof params.ordAddress !== 'string') {
    throw new Error('ordAddress is required and must be a string')
  }
  if (!params.payAddress || typeof params.payAddress !== 'string') {
    throw new Error('payAddress is required and must be a string')
  }
  requireSatoshis(params.price, 'price', 1)
  if (!params.assetId || typeof params.assetId !== 'string') {
    throw new Error('assetId is required and must be a string')
  }
  if (
    params.metadata !== undefined &&
    (params.metadata == null ||
      typeof params.metadata !== 'object' ||
      Array.isArray(params.metadata))
  ) {
    throw new Error('metadata must be an object')
  }
  if (
    params.itemData !== undefined &&
    (params.itemData == null ||
      typeof params.itemData !== 'object' ||
      Array.isArray(params.itemData))
  ) {
    throw new Error('itemData must be an object')
  }
  if (params.metadata !== undefined) validateJsonData(params.metadata, 'metadata')
  if (params.itemData !== undefined) validateJsonData(params.itemData, 'itemData')
}

// Build an output specification for the contract
function buildOutput(satoshis: number, script: number[]): number[] {
  requireSatoshis(satoshis, 'output satoshis')
  const writer = new Writer()
  writer.writeUInt64LEBn(new BigNumber(satoshis))
  writer.writeVarIntNum(script.length)
  writer.write(script)
  return writer.toArray()
}

/**
 * OrdLock (order lock) template.
 *
 * This template creates a locking script that:
 * - Contains an Ordinal envelope ("ord") with an embedded BSV-20 transfer inscription
 * - Encodes cancellation and payment terms into the contract portion
 * - Optionally appends an OP_RETURN JSON payload for application metadata
 */
export default class OrdLock implements ScriptTemplate {
  private readonly wallet?: WalletInterface
  private readonly p2pkh: P2PKH

  /**
   * Creates a new OrdLock instance.
   *
   * @param wallet - Optional wallet used for cancel unlocking (wallet signature)
   */
  constructor(wallet?: WalletInterface) {
    this.wallet = wallet
    this.p2pkh = new P2PKH(wallet)
  }

  /**
   * Creates an OrdLock locking script.
   *
   * The pay output script is produced using the existing WalletP2PKH template.
   * Metadata is appended as OP_RETURN only when `metadata` or `itemData` contains fields.
   */
  async lock(params: OrdLockLockParams): Promise<LockingScript> {
    // Validate the parameters
    validateLockParams(params)

    // Extract the public key hashes from the addresses
    const cancelPkh = fromBase58Check(params.ordAddress).data as number[]
    const payPkh = fromBase58Check(params.payAddress).data as number[]
    if (cancelPkh.length !== 20)
      throw new Error('ordAddress must contain a 20-byte public key hash')
    if (payPkh.length !== 20) throw new Error('payAddress must contain a 20-byte public key hash')

    const inscription = {
      p: 'bsv-20',
      op: 'transfer',
      amt: 1,
      id: params.assetId
    }

    const combinedMetadata = {
      ...params.metadata,
      ...params.itemData
    }

    // Convert the inscription to a hex string
    const inscriptionJsonHex = toHex(JSON.stringify(inscription))

    const prefixAsm = Script.fromHex(OLOCK_PREFIX).toASM()
    const suffixAsm = Script.fromHex(OLOCK_SUFFIX).toASM()

    // Create the pay output script using the existing P2PKH template
    const payLockingScript = await this.p2pkh.lock({ pubkeyhash: payPkh })
    const payOutputBytes = buildOutput(params.price, payLockingScript.toBinary())
    const payOutputHex = bytesToHex(payOutputBytes)

    const cancelPkhHex = bytesToHex(cancelPkh)

    const contentTypeHex = toHex('application/bsv-20')

    // Build the ASM parts for the locking script
    const asmParts = [
      'OP_0',
      'OP_IF',
      toHex('ord'),
      'OP_1',
      contentTypeHex,
      'OP_0',
      inscriptionJsonHex,
      'OP_ENDIF',
      prefixAsm,
      cancelPkhHex,
      payOutputHex,
      suffixAsm
    ]

    // Only include OP_RETURN if there is non-empty metadata.
    if (Object.keys(combinedMetadata).length > 0) {
      const metadataJsonHex = toHex(JSON.stringify(combinedMetadata))
      asmParts.push('OP_RETURN', metadataJsonHex)
    }

    const asm = asmParts.join(' ')

    return LockingScript.fromASM(asm)
  }

  /**
   * ScriptTemplate.unlock dispatcher.
   *
   * - Cancel path (default): wallet signature + pubkey + OP_1
   * - Purchase path (`kind: 'purchase'`): outputs blob + preimage + OP_0
   */
  unlock(params?: OrdLockUnlockParams) {
    if (params != null && (params as any).kind === 'purchase') {
      return this.purchaseUnlock(params as OrdLockPurchaseUnlockParams)
    }
    return this.cancelUnlock(params as OrdLockCancelUnlockParams)
  }

  /**
   * Cancel unlock.
   *
   * Unlocking script format:
   * `<signature> <compressedPubKey> OP_1`
   */
  cancelUnlock(params?: OrdLockCancelUnlockParams): {
    sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>
    estimateLength: () => Promise<109>
  } {
    if (this.wallet == null) {
      throw new Error('Wallet is required for unlocking')
    }

    // Set default values for the unlock parameters
    const p2pkhUnlock = this.p2pkh.unlock({
      protocolID: params?.protocolID ?? ([0, 'ordlock'] as WalletProtocol),
      keyID: params?.keyID ?? '0',
      counterparty: params?.counterparty ?? 'self',
      signOutputs: params?.signOutputs ?? 'all',
      anyoneCanPay: params?.anyoneCanPay ?? false,
      sourceSatoshis: params?.sourceSatoshis,
      lockingScript: params?.lockingScript
    })

    return {
      sign: async (tx: Transaction, inputIndex: number) => {
        const unlockScript = UnlockingScript.fromHex(
          (await p2pkhUnlock.sign(tx, inputIndex)).toHex()
        )
        unlockScript.writeOpCode(OP.OP_1)

        return unlockScript
      },
      estimateLength: async () => 109
    }
  }

  /**
   * Purchase unlock.
   *
   * Unlocking script format:
   * `<outputsBlob> <preimage> OP_0`
   *
   * Note: the unlocking script size depends on final outputs, so `estimateLength`
   * must be called with `(tx, inputIndex)`.
   */
  purchaseUnlock(params?: OrdLockPurchaseUnlockParams): {
    sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>
    estimateLength: (tx: Transaction, inputIndex: number) => Promise<number>
  } {
    const sourceSatoshis = params?.sourceSatoshis
    const lockingScript = params?.lockingScript

    const purchase = {
      sign: async (tx: Transaction, inputIndex: number) => {
        if (tx.outputs.length < 2) {
          throw new Error('Malformed transaction')
        }

        // Build output specifications blob required by the contract
        const output0 = buildOutput(
          requireSatoshis(tx.outputs[0].satoshis, 'output 0 satoshis'),
          tx.outputs[0].lockingScript.toBinary()
        )

        // Build the other outputs blob
        let otherOutputs: number[] | undefined
        if (tx.outputs.length > 2) {
          const writer = new Writer()
          for (const output of tx.outputs.slice(2)) {
            writer.write(
              buildOutput(
                requireSatoshis(output.satoshis, 'output satoshis'),
                output.lockingScript.toBinary()
              )
            )
          }
          otherOutputs = writer.toArray()
        }

        // Calculate the preimage for the signature
        const { preimage } = calculatePreimage(
          tx,
          inputIndex,
          'all',
          true,
          sourceSatoshis,
          lockingScript
        )

        // Build unlocking script: <output0> <otherOutputs|OP_0> <preimage> OP_0
        const unlockingScript = new UnlockingScript()
        unlockingScript.writeBin(output0)
        if (otherOutputs != null && otherOutputs.length > 0) {
          unlockingScript.writeBin(otherOutputs)
        } else {
          unlockingScript.writeOpCode(OP.OP_0)
        }
        unlockingScript.writeBin(preimage)
        unlockingScript.writeOpCode(OP.OP_0)

        return unlockingScript
      },
      estimateLength: async (tx: Transaction, inputIndex: number) => {
        return (await purchase.sign(tx, inputIndex)).toBinary().length
      }
    }

    return purchase
  }
}
