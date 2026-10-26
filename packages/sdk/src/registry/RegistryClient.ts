import type {
  WalletInterface,
  WalletProtocol,
  PubKeyHex,
  SecurityLevel,
  OriginatorDomainNameStringUnder250Bytes
} from '../wallet/Wallet.interfaces.js'
import WalletClient from '../wallet/WalletClient.js'
import { toArray } from '../primitives/utils.js'
import PublicKey from '../primitives/PublicKey.js'
import Transaction from '../transaction/Transaction.js'
import type { BroadcastResponse, BroadcastFailure } from '../transaction/Broadcaster.js'
import LookupResolver, { type LookupNetworkPreset } from '../overlay-tools/LookupResolver.js'
import TopicBroadcaster from '../overlay-tools/SHIPBroadcaster.js'
import PushDrop from '../script/templates/PushDrop.js'
import LockingScript from '../script/LockingScript.js'
import {
  CertificateFieldDescriptor,
  DefinitionData,
  DefinitionType,
  RegistryQueryMapping,
  RegistryRecord
} from './types/index.js'
import { decodeAndVerifyRegistryToken } from './registryTokenValidation.js'
import { completeBoundAction } from '../wallet/completeBoundAction.js'
import { isUnsafeRecordKey } from '../primitives/SafeRecord.js'
import { utf8ByteLength } from '../primitives/UTF8.js'

const REGISTRANT_TOKEN_AMOUNT = 1
const REGISTRANT_KEY_ID = '1'
const MAX_REGISTRY_RESULTS = 1000
const MAX_REGISTRY_BEEF_BYTES = 256 * 1024 * 1024
const MAX_REGISTRY_TEXT_BYTES = 4096
const MAX_REGISTRY_URL_BYTES = 2048

function registryRecord(value: unknown, label: string): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`)
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      typeof key !== 'string' ||
      isUnsafeRecordKey(key) ||
      descriptor == null ||
      !('value' in descriptor)
    ) {
      throw new Error(`${label} contains an unsafe property`)
    }
  }
  return value as Record<string, unknown>
}

function registryString(
  value: unknown,
  label: string,
  minimum = 0,
  maximum = MAX_REGISTRY_TEXT_BYTES
): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const length = utf8ByteLength(value)
  let hasUnsafeControl = false
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 9 || (code > 10 && code < 13) || (code > 13 && code < 32) || code === 127) {
      hasUnsafeControl = true
      break
    }
  }
  if (length < minimum || length > maximum || hasUnsafeControl) {
    throw new Error(`${label} has an invalid length or contains control characters`)
  }
  return value
}

function registryUrl(value: unknown, label: string): string {
  const encoded = registryString(value, label, 0, MAX_REGISTRY_URL_BYTES)
  if (encoded === '') return encoded
  if (!/^[a-z][a-z0-9+.-]*:/i.test(encoded.trim())) return encoded
  let parsed: URL
  try {
    parsed = new URL(encoded)
  } catch {
    throw new Error(`${label} must be an absolute HTTP(S) URL`)
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error(`${label} must be a credential-free HTTP(S) URL without a fragment`)
  }
  return parsed.href
}

function registryBytes(value: unknown): number[] | Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.length === 0 || value.length > MAX_REGISTRY_BEEF_BYTES) {
      throw new Error('Registry BEEF is empty or oversized')
    }
    return value
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REGISTRY_BEEF_BYTES) {
    throw new Error('Registry BEEF is empty or oversized')
  }
  for (let index = 0; index < value.length; index++) {
    if (
      !Object.prototype.hasOwnProperty.call(value, index) ||
      !Number.isInteger(value[index]) ||
      value[index] < 0 ||
      value[index] > 255
    ) {
      throw new Error('Registry BEEF must contain only bytes')
    }
  }
  return value as number[]
}

function certificateFields(value: unknown): Record<string, CertificateFieldDescriptor> {
  const fields = registryRecord(value, 'Certificate fields')
  const names = Object.keys(fields)
  if (names.length > 64) throw new Error('Certificate fields contains too many entries')
  const validated: Record<string, CertificateFieldDescriptor> = Object.create(null)
  for (const name of names) {
    registryString(name, 'Certificate field name', 1, 50)
    const descriptor = registryRecord(fields[name], `Certificate field ${name}`)
    const allowedKeys = new Set(['friendlyName', 'description', 'type', 'fieldIcon'])
    if (Object.keys(descriptor).some(key => !allowedKeys.has(key))) {
      throw new Error(`Certificate field ${name} contains an unknown property`)
    }
    if (
      descriptor.type !== 'text' &&
      descriptor.type !== 'imageURL' &&
      descriptor.type !== 'other'
    ) {
      throw new Error(`Certificate field ${name} has an unsupported type`)
    }
    validated[name] = {
      friendlyName: registryString(descriptor.friendlyName, `${name}.friendlyName`, 1, 300),
      description: registryString(descriptor.description, `${name}.description`),
      type: descriptor.type,
      fieldIcon: registryUrl(descriptor.fieldIcon, `${name}.fieldIcon`)
    }
  }
  return validated
}

function validateDefinitionData(value: unknown): DefinitionData {
  const data = registryRecord(value, 'Registry definition')
  if (
    data.definitionType !== 'basket' &&
    data.definitionType !== 'protocol' &&
    data.definitionType !== 'certificate'
  ) {
    throw new Error('Unsupported definition type')
  }
  const common = {
    name: registryString(data.name, 'Registry name', 1, 300),
    iconURL: registryUrl(data.iconURL, 'Registry icon URL'),
    description: registryString(data.description, 'Registry description'),
    documentationURL: registryUrl(data.documentationURL, 'Registry documentation URL')
  }
  if (data.definitionType === 'basket') {
    return {
      definitionType: 'basket',
      basketID: registryString(data.basketID, 'Basket ID', 1, 300),
      ...common
    }
  }
  if (data.definitionType === 'protocol') {
    if (!Array.isArray(data.protocolID) || data.protocolID.length !== 2) {
      throw new Error('Registry protocol ID must contain a security level and protocol name')
    }
    const security = data.protocolID[0]
    if (security !== 0 && security !== 1 && security !== 2) {
      throw new Error('Registry protocol security level is invalid')
    }
    return {
      definitionType: 'protocol',
      protocolID: [security, registryString(data.protocolID[1], 'Registry protocol name', 5, 400)],
      ...common
    }
  }
  if (data.definitionType === 'certificate') {
    return {
      definitionType: 'certificate',
      type: registryString(data.type, 'Certificate type', 1, 300),
      fields: certificateFields(data.fields),
      ...common
    }
  }
  throw new Error('Unsupported registry definition type')
}

function validateRegistryQuery<T extends DefinitionType>(
  definitionType: T,
  value: unknown
): RegistryQueryMapping[T] {
  const query = registryRecord(value, 'Registry query')
  const allowed =
    definitionType === 'basket'
      ? new Set(['basketID', 'name', 'registryOperators'])
      : definitionType === 'protocol'
        ? new Set(['protocolID', 'name', 'registryOperators'])
        : new Set(['type', 'name', 'registryOperators'])
  if (Object.keys(query).some(key => !allowed.has(key))) {
    throw new Error('Registry query contains an unknown property')
  }
  const validated: Record<string, unknown> = Object.create(null)
  if (query.name !== undefined) validated.name = registryString(query.name, 'Query name', 1, 300)
  if (definitionType === 'basket' && query.basketID !== undefined) {
    validated.basketID = registryString(query.basketID, 'Query basket ID', 1, 300)
  }
  if (definitionType === 'certificate' && query.type !== undefined) {
    validated.type = registryString(query.type, 'Query certificate type', 1, 300)
  }
  if (definitionType === 'protocol' && query.protocolID !== undefined) {
    if (!Array.isArray(query.protocolID)) throw new Error('Query protocol ID is invalid')
    validated.protocolID = deserializeWalletProtocol(JSON.stringify(query.protocolID))
  }
  if (query.registryOperators !== undefined) {
    if (!Array.isArray(query.registryOperators) || query.registryOperators.length > 100) {
      throw new Error('Query registry operators must be a bounded array')
    }
    validated.registryOperators = query.registryOperators.map((operator, index) => {
      const encoded = registryString(operator, `Query registry operator ${index}`, 66, 66)
      PublicKey.fromString(encoded)
      return encoded
    })
  }
  return validated as RegistryQueryMapping[T]
}

/**
 * RegistryClient manages on-chain registry definitions for three types:
 * - basket (basket-based items)
 * - protocol (protocol-based items)
 * - certificate (certificate-based items)
 *
 * It provides methods to:
 * - Register new definitions using pushdrop-based UTXOs.
 * - Resolve existing definitions using a lookup service.
 * - List registry entries associated with the operator's wallet.
 * - Remove existing registry entries by spending their UTXOs.
 * - Update existing registry entries.
 *
 * Registry operators use this client to establish and manage
 * canonical references for baskets, protocols, and certificate types.
 */
export class RegistryClient {
  #network: LookupNetworkPreset | undefined
  private resolver: LookupResolver
  readonly #networkPreset: LookupNetworkPreset | undefined
  #cachedIdentityKey: PubKeyHex | undefined
  readonly #acceptDelayedBroadcast: boolean
  readonly #wallet: WalletInterface
  readonly #originator?: OriginatorDomainNameStringUnder250Bytes

  constructor(
    wallet: WalletInterface = new WalletClient(),
    options: {
      acceptDelayedBroadcast?: boolean
      resolver?: LookupResolver
      networkPreset?: LookupNetworkPreset
    } = {},
    originator?: OriginatorDomainNameStringUnder250Bytes
  ) {
    this.#wallet = wallet
    this.#originator = originator
    this.#acceptDelayedBroadcast = options.acceptDelayedBroadcast ?? false
    this.#networkPreset = options.networkPreset
    this.resolver = options.resolver ?? new LookupResolver({ networkPreset: options.networkPreset })
  }

  /**
   * Gets the wallet's identity key, caching it after the first call.
   * @returns The public identity key as a hex string.
   */
  async #getIdentityKey(): Promise<PubKeyHex> {
    this.#cachedIdentityKey ??= (await this.#wallet.getPublicKey({ identityKey: true })).publicKey
    return this.#cachedIdentityKey
  }

  /**
   * Gets the network, initializing and caching it on first call.
   * @returns The network type ('mainnet' or 'testnet').
   */
  async #getNetwork(): Promise<LookupNetworkPreset> {
    this.#network ??= this.#networkPreset ?? (await this.#wallet.getNetwork({})).network
    return this.#network
  }

  /**
   * Publishes a new on-chain definition for baskets, protocols, or certificates.
   * The definition data is encoded in a pushdrop-based UTXO.
   *
   * Registry operators (i.e., identity key owners) can create these definitions
   * to establish canonical references for basket IDs, protocol specs, or certificate schemas.
   *
   * @param data - Structured information about a 'basket', 'protocol', or 'certificate'.
   * @returns A promise with the broadcast result or failure.
   */
  async registerDefinition(data: DefinitionData): Promise<BroadcastResponse | BroadcastFailure> {
    data = validateDefinitionData(data)
    const registryOperator = await this.#getIdentityKey()
    const pushdrop = new PushDrop(this.#wallet, this.#originator)

    // Convert definition data into PushDrop fields
    const fields = this.#buildPushDropFields(data, registryOperator)

    // Convert the user-friendly definitionType to the actual wallet protocol
    const protocol = this.#mapDefinitionTypeToWalletProtocol(data.definitionType)

    // Lock the fields into a pushdrop-based UTXO
    const lockingScript = await pushdrop.lock(fields, protocol, REGISTRANT_KEY_ID, 'anyone', true)

    // Create a transaction
    const transaction = await completeBoundAction(
      this.#wallet,
      {
        description: `Register a new ${data.definitionType} item`,
        outputs: [
          {
            satoshis: REGISTRANT_TOKEN_AMOUNT,
            lockingScript: lockingScript.toHex(),
            outputDescription: `New ${data.definitionType} registration token`,
            basket: this.#mapDefinitionTypeToBasketName(data.definitionType)
          }
        ],
        options: {
          acceptDelayedBroadcast: this.#acceptDelayedBroadcast,
          randomizeOutputs: false
        }
      },
      {},
      this.#originator
    )
    // Broadcast to the relevant topic
    const broadcaster = new TopicBroadcaster(
      [this.#mapDefinitionTypeToTopic(data.definitionType)],
      {
        networkPreset: await this.#getNetwork(),
        resolver: this.resolver
      }
    )
    const result = await broadcaster.broadcast(transaction)
    return result
  }

  /**
   * Resolves registrant tokens of a particular type using a lookup service.
   *
   * The query object shape depends on the registry type:
   * - For "basket", the query is of type BasketMapQuery:
   *   { basketID?: string; name?: string; registryOperators?: string[]; }
   * - For "protocol", the query is of type ProtoMapQuery:
   *   { name?: string; registryOperators?: string[]; protocolID?: WalletProtocol; }
   * - For "certificate", the query is of type CertMapQuery:
   *   { type?: string; name?: string; registryOperators?: string[]; }
   *
   * @param definitionType - The registry type, which can be 'basket', 'protocol', or 'certificate'.
   * @param query - The query object used to filter registry records, whose shape is determined by the registry type.
   * @returns A promise that resolves to an array of matching registry records.
   */
  async resolve<T extends DefinitionType>(
    definitionType: T,
    query: RegistryQueryMapping[T]
  ): Promise<DefinitionData[]> {
    const serviceName = this.#mapDefinitionTypeToServiceName(definitionType)
    query = validateRegistryQuery(definitionType, query)

    // Make the lookup query
    const result = await this.resolver.query({ service: serviceName, query })
    if (result.type !== 'output-list') {
      return []
    }

    const parsedRegistryRecords: DefinitionData[] = []
    for (const output of result.outputs.slice(0, MAX_REGISTRY_RESULTS)) {
      try {
        const parsedTx = Transaction.fromBEEF(registryBytes(output.beef))
        if (!Number.isSafeInteger(output.outputIndex) || output.outputIndex < 0) continue
        const lockingScript = parsedTx.outputs[output.outputIndex]?.lockingScript
        if (lockingScript == null) continue
        const record = await this.#parseLockingScript(definitionType, lockingScript)
        parsedRegistryRecords.push(record)
      } catch {
        // Skip invalid or non-pushdrop outputs
      }
    }
    return parsedRegistryRecords
  }

  /**
   * Lists the registry operator's published definitions for the given type.
   *
   * Returns parsed registry records including transaction details such as txid, outputIndex, satoshis, and the locking script.
   *
   * @param definitionType - The type of registry definition to list ('basket', 'protocol', or 'certificate').
   * @returns A promise that resolves to an array of RegistryRecord objects.
   */
  async listOwnRegistryEntries(definitionType: DefinitionType): Promise<RegistryRecord[]> {
    const relevantBasketName = this.#mapDefinitionTypeToBasketName(definitionType)
    const { outputs, BEEF } = await this.#wallet.listOutputs({
      basket: relevantBasketName,
      include: 'entire transactions'
    })

    const results: RegistryRecord[] = []
    for (const output of outputs.slice(0, MAX_REGISTRY_RESULTS)) {
      if (!output.spendable) {
        continue
      }
      try {
        const match = /^([0-9a-f]{64})\.(0|[1-9]\d*)$/i.exec(output.outpoint)
        if (match == null) continue
        const txid = match[1].toLowerCase()
        const outputIndex = Number(match[2])
        if (!Number.isSafeInteger(outputIndex) || outputIndex > 0xffffffff) continue
        const beef = registryBytes(BEEF)
        const tx = Transaction.fromBEEF(beef, txid)
        if (tx.id('hex').toLowerCase() !== txid) continue
        const sourceOutput = tx.outputs[outputIndex]
        if (
          sourceOutput?.lockingScript == null ||
          sourceOutput.satoshis !== output.satoshis ||
          sourceOutput.satoshis !== REGISTRANT_TOKEN_AMOUNT
        )
          continue
        const lockingScript: LockingScript = sourceOutput.lockingScript
        const record = await this.#parseLockingScript(definitionType, lockingScript)
        results.push({
          ...record,
          txid,
          outputIndex,
          satoshis: sourceOutput.satoshis,
          lockingScript: lockingScript.toHex(),
          beef: Array.from(beef)
        })
      } catch {
        // Ignore parse errors
      }
    }

    return results
  }

  private async authenticateRegistryRecord(value: unknown): Promise<{
    definition: DefinitionData
    txid: string
    outputIndex: number
    lockingScript: LockingScript
    satoshis: number
    beef: number[]
  }> {
    const record = registryRecord(value, 'Registry record')
    if (
      record.definitionType !== 'basket' &&
      record.definitionType !== 'protocol' &&
      record.definitionType !== 'certificate'
    ) {
      throw new Error('Registry record has an invalid definition type')
    }
    if (typeof record.txid !== 'string' || !/^[0-9a-f]{64}$/i.test(record.txid)) {
      throw new Error('Registry record has an invalid transaction ID')
    }
    const txid = record.txid.toLowerCase()
    if (
      !Number.isSafeInteger(record.outputIndex) ||
      (record.outputIndex as number) < 0 ||
      (record.outputIndex as number) > 0xffffffff
    ) {
      throw new Error('Registry record has an invalid output index')
    }
    const outputIndex = record.outputIndex as number
    const beef = registryBytes(record.beef)
    const transaction = Transaction.fromBEEF(beef, txid)
    if (transaction.id('hex').toLowerCase() !== txid) {
      throw new Error('Registry record BEEF does not contain the declared transaction')
    }
    const sourceOutput = transaction.outputs[outputIndex]
    if (sourceOutput?.lockingScript == null || sourceOutput.satoshis !== REGISTRANT_TOKEN_AMOUNT) {
      throw new Error('Registry record does not identify a valid registration token output')
    }
    if (
      record.satoshis !== sourceOutput.satoshis ||
      typeof record.lockingScript !== 'string' ||
      record.lockingScript.toLowerCase() !== sourceOutput.lockingScript.toHex().toLowerCase()
    ) {
      throw new Error('Registry record metadata does not match its authenticated source output')
    }
    const definition = await this.#parseLockingScript(
      record.definitionType,
      sourceOutput.lockingScript
    )
    const currentIdentityKey = await this.#getIdentityKey()
    if (definition.registryOperator !== currentIdentityKey) {
      throw new Error('This registry token does not belong to the current wallet.')
    }
    return {
      definition,
      txid,
      outputIndex,
      lockingScript: sourceOutput.lockingScript,
      satoshis: sourceOutput.satoshis,
      beef: Array.from(beef)
    }
  }

  /**
   * Removes a registry definition by spending its associated UTXO.
   *
   * @param registryRecord - The registry record to remove (must have valid txid, outputIndex, and lockingScript).
   * @returns Broadcast success/failure.
   */
  async removeDefinition(
    registryRecord: RegistryRecord
  ): Promise<BroadcastResponse | BroadcastFailure> {
    const authenticated = await this.authenticateRegistryRecord(registryRecord)
    const definition = authenticated.definition

    // Create a descriptive label for the item we're removing
    let itemIdentifier: string | undefined
    if (definition.definitionType === 'basket') {
      itemIdentifier = definition.basketID
    } else if (definition.definitionType === 'protocol') {
      itemIdentifier = definition.name
    } else if (definition.definitionType === 'certificate') {
      itemIdentifier = definition.name ?? definition.type
    } else {
      itemIdentifier = 'unknown'
    }

    const outpoint = `${authenticated.txid}.${authenticated.outputIndex}`
    const pushdrop = new PushDrop(this.#wallet, this.#originator)
    const unlocker = pushdrop.unlock(
      this.#mapDefinitionTypeToWalletProtocol(definition.definitionType),
      REGISTRANT_KEY_ID,
      'anyone',
      'all',
      false,
      authenticated.satoshis,
      authenticated.lockingScript
    )
    const transaction = await completeBoundAction(
      this.#wallet,
      {
        description: `Remove ${definition.definitionType} item: ${itemIdentifier}`,
        inputBEEF: authenticated.beef,
        inputs: [
          {
            outpoint,
            unlockingScriptLength: 74,
            inputDescription: `Removing ${definition.definitionType} token`
          }
        ],
        options: {
          acceptDelayedBroadcast: this.#acceptDelayedBroadcast,
          randomizeOutputs: false
        }
      },
      { inputSigners: { [outpoint]: unlocker.sign } },
      this.#originator
    )
    // Broadcast
    const broadcaster = new TopicBroadcaster(
      [this.#mapDefinitionTypeToTopic(definition.definitionType)],
      {
        networkPreset: await this.#getNetwork(),
        resolver: this.resolver
      }
    )
    const result = await broadcaster.broadcast(transaction)
    return result
  }

  /**
   * Updates an existing registry record by spending its UTXO and creating a new one with updated data.
   *
   * @param registryRecord - The existing registry record to update (must have valid txid, outputIndex, and lockingScript).
   * @param updatedData - The new definition data to replace the old record.
   * @returns Broadcast success/failure.
   */
  async updateDefinition(
    registryRecord: RegistryRecord,
    updatedData: DefinitionData
  ): Promise<BroadcastResponse | BroadcastFailure> {
    updatedData = validateDefinitionData(updatedData)
    const authenticated = await this.authenticateRegistryRecord(registryRecord)
    const definition = authenticated.definition

    // Verify the updated data matches the record type
    if (definition.definitionType !== updatedData.definitionType) {
      throw new Error(
        `Cannot change definition type from ${definition.definitionType} to ${updatedData.definitionType}`
      )
    }
    const currentIdentityKey = await this.#getIdentityKey()

    // Create a descriptive label for the item we're updating
    let itemIdentifier: string | undefined
    if (definition.definitionType === 'basket') {
      itemIdentifier = definition.basketID
    } else if (definition.definitionType === 'protocol') {
      itemIdentifier = definition.name
    } else if (definition.definitionType === 'certificate') {
      itemIdentifier = definition.name ?? definition.type
    } else {
      itemIdentifier = 'unknown'
    }

    const pushdrop = new PushDrop(this.#wallet, this.#originator)

    // Build the new locking script with updated data
    const fields = this.#buildPushDropFields(updatedData, currentIdentityKey)
    const protocol = this.#mapDefinitionTypeToWalletProtocol(updatedData.definitionType)
    const newLockingScript = await pushdrop.lock(
      fields,
      protocol,
      REGISTRANT_KEY_ID,
      'anyone',
      true
    )

    const outpoint = `${authenticated.txid}.${authenticated.outputIndex}`
    const unlocker = pushdrop.unlock(
      this.#mapDefinitionTypeToWalletProtocol(definition.definitionType),
      REGISTRANT_KEY_ID,
      'anyone',
      'all',
      false,
      authenticated.satoshis,
      authenticated.lockingScript
    )
    const transaction = await completeBoundAction(
      this.#wallet,
      {
        description: `Update ${definition.definitionType} item: ${itemIdentifier}`,
        inputBEEF: authenticated.beef,
        inputs: [
          {
            outpoint,
            unlockingScriptLength: 74,
            inputDescription: `Updating ${definition.definitionType} token`
          }
        ],
        outputs: [
          {
            satoshis: REGISTRANT_TOKEN_AMOUNT,
            lockingScript: newLockingScript.toHex(),
            outputDescription: `Updated ${definition.definitionType} registration token`,
            basket: this.#mapDefinitionTypeToBasketName(definition.definitionType)
          }
        ],
        options: {
          acceptDelayedBroadcast: this.#acceptDelayedBroadcast,
          randomizeOutputs: false
        }
      },
      { inputSigners: { [outpoint]: unlocker.sign } },
      this.#originator
    )

    // Broadcast
    const broadcaster = new TopicBroadcaster(
      [this.#mapDefinitionTypeToTopic(definition.definitionType)],
      {
        networkPreset: await this.#getNetwork(),
        resolver: this.resolver
      }
    )
    return await broadcaster.broadcast(transaction)
  }

  // --------------------------------------------------------------------------
  // INTERNAL UTILITY METHODS
  // --------------------------------------------------------------------------

  /**
   * Convert definition data into an array of pushdrop fields (strings).
   * Each definition type has a slightly different shape.
   */
  #buildPushDropFields(data: DefinitionData, registryOperator: PubKeyHex): number[][] {
    let fields: string[]

    switch (data.definitionType) {
      case 'basket':
        fields = [data.basketID, data.name, data.iconURL, data.description, data.documentationURL]
        break
      case 'protocol':
        fields = [
          JSON.stringify(data.protocolID),
          data.name,
          data.iconURL,
          data.description,
          data.documentationURL
        ]
        break
      case 'certificate':
        fields = [
          data.type,
          data.name,
          data.iconURL,
          data.description,
          data.documentationURL,
          JSON.stringify(data.fields)
        ]
        break
      default:
        throw new Error('Unsupported definition type')
    }

    // Append the operator's public identity key last
    fields.push(registryOperator)

    return fields.map(field => toArray(field))
  }

  /**
   * Decodes a pushdrop locking script for a given definition type,
   * returning a typed record with the appropriate fields.
   */
  async #parseLockingScript(
    definitionType: DefinitionType,
    lockingScript: LockingScript
  ): Promise<DefinitionData> {
    const fields = await decodeAndVerifyRegistryToken(definitionType, lockingScript)
    let parsedData: DefinitionData
    switch (definitionType) {
      case 'basket': {
        const [basketID, name, iconURL, description, docURL, registryOperator] = fields
        parsedData = validateDefinitionData({
          definitionType: 'basket',
          basketID,
          name,
          iconURL,
          description,
          documentationURL: docURL
        })
        parsedData.registryOperator = registryOperator
        break
      }

      case 'protocol': {
        const [protocolID, name, iconURL, description, docURL, registryOperator] = fields
        parsedData = validateDefinitionData({
          definitionType: 'protocol',
          protocolID: deserializeWalletProtocol(protocolID),
          name,
          iconURL,
          description,
          documentationURL: docURL
        })
        parsedData.registryOperator = registryOperator
        break
      }

      case 'certificate': {
        const [certType, name, iconURL, description, docURL, fieldsJSON, registryOperator] = fields
        const parsedFields: unknown = JSON.parse(fieldsJSON)
        parsedData = validateDefinitionData({
          definitionType: 'certificate',
          type: certType,
          name,
          iconURL,
          description,
          documentationURL: docURL,
          fields: parsedFields
        })
        parsedData.registryOperator = registryOperator
        break
      }

      default:
        throw new Error(`Unsupported definition type: ${definitionType as string}`)
    }

    return parsedData
  }

  /**
   * Convert our definitionType to the wallet protocol format ([protocolID, keyID]).
   */
  #mapDefinitionTypeToWalletProtocol(definitionType: DefinitionType): WalletProtocol {
    switch (definitionType) {
      case 'basket':
        return [1, 'basketmap']
      case 'protocol':
        return [1, 'protomap']
      case 'certificate':
        return [1, 'certmap']
      default:
        throw new Error(`Unknown definition type: ${definitionType as string}`)
    }
  }

  /**
   * Convert 'basket'|'protocol'|'certificate' to the basket name used by the wallet.
   */
  #mapDefinitionTypeToBasketName(definitionType: DefinitionType): string {
    switch (definitionType) {
      case 'basket':
        return 'basketmap'
      case 'protocol':
        return 'protomap'
      case 'certificate':
        return 'certmap'
      default:
        throw new Error(`Unknown definition type: ${definitionType as string}`)
    }
  }

  /**
   * Convert 'basket'|'protocol'|'certificate' to the broadcast topic name.
   */
  #mapDefinitionTypeToTopic(definitionType: DefinitionType): string {
    switch (definitionType) {
      case 'basket':
        return 'tm_basketmap'
      case 'protocol':
        return 'tm_protomap'
      case 'certificate':
        return 'tm_certmap'
      default:
        throw new Error(`Unknown definition type: ${definitionType as string}`)
    }
  }

  /**
   * Convert 'basket'|'protocol'|'certificate' to the lookup service name.
   */
  #mapDefinitionTypeToServiceName(definitionType: DefinitionType): string {
    switch (definitionType) {
      case 'basket':
        return 'ls_basketmap'
      case 'protocol':
        return 'ls_protomap'
      case 'certificate':
        return 'ls_certmap'
      default:
        throw new Error(`Unknown definition type: ${definitionType as string}`)
    }
  }
}

export function deserializeWalletProtocol(str: string): WalletProtocol {
  // Parse the JSON string back into a JavaScript value.
  const parsed = JSON.parse(str)

  // Validate that the parsed value is an array with exactly two elements.
  if (!Array.isArray(parsed) || parsed.length !== 2) {
    throw new Error('Invalid wallet protocol format.')
  }

  const [security, protocolString] = parsed

  // Validate that the security level is one of the allowed numbers.
  if (![0, 1, 2].includes(security)) {
    throw new Error('Invalid security level.')
  }

  // Validate that the protocol string is a string and its length is within the allowed bounds.
  if (typeof protocolString !== 'string') {
    throw new TypeError('Invalid protocolID')
  }

  registryString(protocolString, 'protocolID', 5, 400)

  return [security as SecurityLevel, protocolString]
}
