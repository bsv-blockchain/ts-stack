import { LockingScript, Utils, WalletInterface, ScriptTemplate, Transaction, UnlockingScript } from '@bsv/sdk'

import P2PKH from './p2pkh'
import { ORDINAL_MAP_PREFIX } from '../utils/constants'
import {
  OrdinalLockParams,
  OrdinalLockWithPubkeyhash,
  OrdinalLockWithAddress,
  OrdinalLockWithPublicKey,
  OrdinalLockWithWallet,
  OrdinalUnlockParams
} from './types'

export interface Inscription {
  dataB64: string
  contentType: string
}

export interface MAP {
  app: string
  type: string
  [prop: string]: string
}

const toHex = (str: string) => {
  return Utils.toHex(Utils.toArray(str))
}

/**
 * OrdP2PKH (1Sat Ordinal + Pay To Public Key Hash) class implementing ScriptTemplate.
 *
 * This class provides methods to create Pay To Public Key Hash locking scripts with 1Sat Ordinal
 * inscriptions and MAP metadata using a BRC-100 compatible wallet interface.
 */
export default class OrdP2PKH implements ScriptTemplate {
  private readonly p2pkh: P2PKH

  /**
	 * Creates a new OrdP2PKH instance.
	 *
	 * @param wallet - Optional BRC-100 compatible wallet interface
	 */
  constructor (wallet?: WalletInterface) {
    this.p2pkh = new P2PKH(wallet)
  }

  /**
	 * Creates a 1Sat Ordinal + P2PKH locking script from a public key hash.
	 *
	 * @param params - Object containing pubkeyhash, inscription, and metadata
	 * @returns A P2PKH locking script with ordinal inscription
	 */
  lock (params: OrdinalLockWithPubkeyhash): Promise<LockingScript>
  lock (params: OrdinalLockWithAddress): Promise<LockingScript>
  /**
	 * Creates a 1Sat Ordinal + P2PKH locking script from a public key string.
	 *
	 * @param params - Object containing publicKey, inscription, and metadata
	 * @returns A P2PKH locking script with ordinal inscription
	 */
  lock (params: OrdinalLockWithPublicKey): Promise<LockingScript>
  /**
	 * Creates a 1Sat Ordinal + P2PKH locking script using the instance's BRC-100 wallet to derive the public key.
	 *
	 * @param params - Object containing walletParams, inscription, and metadata
	 * @returns A P2PKH locking script with ordinal inscription
	 */
  lock (params: OrdinalLockWithWallet): Promise<LockingScript>
  async lock (params: OrdinalLockParams): Promise<LockingScript> {
    // Validate params exists before accessing properties
    if (!params || typeof params !== 'object') {
      throw new Error('One of pubkeyhash, publicKey, or walletParams is required')
    }

    // Validate inscription structure if provided
    if (params.inscription !== undefined) {
      if (typeof params.inscription !== 'object' || params.inscription === null) {
        throw new Error('inscription must be an object with dataB64 and contentType properties')
      }
      if (!params.inscription.dataB64 || typeof params.inscription.dataB64 !== 'string') {
        throw new Error('inscription.dataB64 is required and must be a base64 string')
      }
      if (!params.inscription.contentType || typeof params.inscription.contentType !== 'string') {
        throw new Error('inscription.contentType is required and must be a string (MIME type)')
      }
    }

    // Validate MAP metadata structure if provided
    if (params.metadata !== undefined) {
      if (typeof params.metadata !== 'object' || params.metadata === null) {
        throw new Error('metadata must be an object')
      }
      if (!params.metadata.app || typeof params.metadata.app !== 'string') {
        throw new Error('metadata.app is required and must be a string')
      }
      if (!params.metadata.type || typeof params.metadata.type !== 'string') {
        throw new Error('metadata.type is required and must be a string')
      }
    }

    let lockingScript: LockingScript

    // Determine which parameter was provided and delegate to p2pkh
    if ('pubkeyhash' in params) {
      lockingScript = await this.p2pkh.lock({ pubkeyhash: params.pubkeyhash })
    } else if ('address' in params) {
      lockingScript = await this.p2pkh.lock({ address: params.address })
    } else if ('publicKey' in params) {
      lockingScript = await this.p2pkh.lock({ publicKey: params.publicKey })
    } else if ('walletParams' in params) {
      lockingScript = await this.p2pkh.lock({ walletParams: params.walletParams })
    } else {
      throw new Error('One of pubkeyhash, address, publicKey, or walletParams is required')
    }

    // Apply ordinal inscription and MAP metadata
    return applyInscription(lockingScript, params.inscription, params.metadata)
  }

  /**
	 * Creates a function that generates a P2PKH unlocking script using the instance's BRC-100 wallet.
	 *
	 * @param params - Named parameters object (see P2PKH.unlock for details)
	 * @param params.protocolID - Protocol identifier for key derivation (default: [2, "p2pkh"])
	 * @param params.keyID - Specific key identifier within the protocol (default: '0')
	 * @param params.counterparty - The counterparty for which the key is being used (default: 'self')
	 * @param params.signOutputs - The signature scope for outputs: 'all', 'none', or 'single' (default: 'all')
	 * @param params.anyoneCanPay - Flag indicating if the signature allows for other inputs to be added later (default: false)
	 * @param params.sourceSatoshis - Optional. The amount in satoshis being unlocked. Otherwise input.sourceTransaction is required.
	 * @param params.lockingScript - Optional. The locking script being unlocked. Otherwise input.sourceTransaction is required.
	 * @returns An object containing the `sign` and `estimateLength` functions
	 */
  unlock (params?: OrdinalUnlockParams): {
    sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>
    estimateLength: () => Promise<108>
  } {
    return this.p2pkh.unlock(params)
  }
}

/**
 * Applies ordinal inscription and MAP metadata to a P2PKH locking script.
 *
 * @param lockingScript - Base P2PKH locking script
 * @param inscription - Optional file data to inscribe (can be omitted for metadata-only updates)
 * @param metaData - Optional MAP metadata (requires both app and type fields if provided)
 * @param withSeparator - If true, adds OP_CODESEPARATOR between ordinal and P2PKH script
 * @returns Locking script with ordinal inscription and MAP metadata
 */
export const applyInscription = (
  lockingScript: LockingScript,
  inscription?: Inscription,
  metaData?: MAP,
  withSeparator = false
): LockingScript => {
  let ordAsm = ''

  // Create ordinal envelope if inscription data is provided
  if (inscription?.dataB64 !== undefined && inscription?.contentType !== undefined) {
    const ordHex = toHex('ord')
    const fsBuffer = Buffer.from(inscription.dataB64, 'base64')
    const fileHex = fsBuffer.toString('hex').trim()
    if (!fileHex) {
      throw new Error('Invalid file data')
    }
    const fileMediaType = toHex(inscription.contentType)
    if (!fileMediaType) {
      throw new Error('Invalid media type')
    }
    ordAsm = `OP_0 OP_IF ${ordHex} OP_1 ${fileMediaType} OP_0 ${fileHex} OP_ENDIF`
  }

  // Combine ordinal envelope with P2PKH locking script
  let inscriptionAsm = `${ordAsm ? `${ordAsm} ${withSeparator ? 'OP_CODESEPARATOR ' : ''}` : ''}${lockingScript.toASM()}`

  // Validate and append MAP metadata if provided
  if ((metaData != null) && (!metaData.app || !metaData.type)) {
    throw new Error('MAP.app and MAP.type are required fields')
  }

  if (metaData?.app && metaData?.type) {
    const mapPrefixHex = toHex(ORDINAL_MAP_PREFIX)
    const mapCmdValue = toHex('SET')
    inscriptionAsm = `${inscriptionAsm ? `${inscriptionAsm} ` : ''}OP_RETURN ${mapPrefixHex} ${mapCmdValue}`

    for (const [key, value] of Object.entries(metaData)) {
      if (key !== 'cmd') {
        inscriptionAsm = `${inscriptionAsm} ${toHex(key)} ${toHex(
					value
				)}`
      }
    }
  }

  return LockingScript.fromASM(inscriptionAsm)
}
