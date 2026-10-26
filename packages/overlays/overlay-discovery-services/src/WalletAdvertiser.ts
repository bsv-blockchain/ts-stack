import { toArray, toHex, toUTF8Strict } from '@bsv/sdk/primitives/utils'
import {
  Beef,
  completeBoundAction,
  type CreateActionInput,
  decodeCanonicalPushDrop,
  KeyDeriver,
  LockingScript,
  LookupResolver,
  type LookupResolverConfig,
  PrivateKey,
  PublicKey,
  PushDrop,
  Script,
  type TaggedBEEF,
  Transaction,
  type WalletInterface,
  type WalletProtocol,
  type LookupNetworkPreset
} from '@bsv/sdk'
import { Advertisement, AdvertisementData, Advertiser } from '@bsv/overlay'
import {
  Wallet,
  WalletSigner,
  WalletStorageManager,
  StorageClient,
  Services
} from '@bsv/wallet-toolbox-client'
import {
  isAdmissibleDiscoveryOutput,
  type DiscoveryProtocol
} from './utils/isAdmissibleDiscoveryOutput.js'
import { isAdvertisableURI } from './utils/isAdvertisableURI.js'
import { isValidTopicOrServiceName } from './utils/isValidTopicOrServiceName.js'

const AD_TOKEN_VALUE = 1
const MAX_ADVERTISEMENTS = 10_000
const MAX_ADVERTISEMENT_BEEF_BYTES = 16 * 1024 * 1024
const MAX_TOTAL_ADVERTISEMENT_BEEF_BYTES = 128 * 1024 * 1024
const MAX_DISCOVERY_FIELD_BYTES = 4096
const MAX_DISCOVERY_PAYLOAD_BYTES = 8192
const protocolNamePrefix: Record<DiscoveryProtocol, string> = {
  SHIP: 'tm_',
  SLAP: 'ls_'
}

function protocolID(protocol: DiscoveryProtocol): WalletProtocol {
  return [2, protocol === 'SHIP' ? 'service host interconnect' : 'service lookup availability']
}

function plainDataRecord(value: unknown, label: string): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain data object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain data object`)
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || descriptor == null || !('value' in descriptor)) {
      throw new Error(`${label} must contain only string-keyed data properties`)
    }
  }
  return value as Record<string, unknown>
}

function discoveryProtocol(value: unknown, label: string): DiscoveryProtocol {
  if (value !== 'SHIP' && value !== 'SLAP') {
    throw new Error(`${label} must be SHIP or SLAP`)
  }
  return value
}

function outputIndex(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0xffffffff) {
    throw new Error(`${label} must be an unsigned 32-bit integer`)
  }
  return value as number
}

function boundedBEEF(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ADVERTISEMENT_BEEF_BYTES) {
    throw new Error(`${label} must be a bounded non-empty byte array`)
  }
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index)
    if (
      descriptor == null ||
      !('value' in descriptor) ||
      !Number.isInteger(descriptor.value) ||
      descriptor.value < 0 ||
      descriptor.value > 255
    ) {
      throw new Error(`${label} must be a bounded non-empty byte array`)
    }
  }
  return value as number[]
}

/**
 * Implements the Advertiser interface for managing SHIP and SLAP advertisements using a Wallet.
 */
export class WalletAdvertiser implements Advertiser {
  private readonly wallet: WalletInterface
  private readonly storageManager: WalletStorageManager
  private readonly identityKey: string
  private initialized: boolean

  /**
   * Constructs a new WalletAdvertiser instance.
   * @param chain - The blockchain (main, test, or TTN) where this advertiser is advertising
   * @param privateKey - The private key used for signing transactions.
   * @param storageURL - The URL of the UTXO storage server for the Wallet.
   * @param advertisableURI - The advertisable URI where services are made available.
   * @param lookupResolverConfig — If provided, overrides the resolver config used for lookups. Otherwise defaults to the network preset associated with the wallet's network.
   */
  constructor(
    public chain: 'main' | 'test' | 'ttn',
    /**
     * @deprecated Retained as a public property only for API compatibility.
     * It is a root wallet secret: never serialize, log, expose, or share a
     * WalletAdvertiser instance across a trust boundary.
     */
    public privateKey: string,
    public storageURL: string,
    public advertisableURI: string,
    public lookupResolverConfig?: LookupResolverConfig
  ) {
    if (!isAdvertisableURI(advertisableURI)) {
      throw new Error(`Refusing to initialize with non-advertisable URI: ${advertisableURI}`)
    }
    const keyDeriver = new KeyDeriver(new PrivateKey(privateKey, 'hex'))
    const storageManager = new WalletStorageManager(keyDeriver.identityKey)
    const signer = new WalletSigner(chain, keyDeriver, storageManager)
    const services = new Services(chain)
    const wallet = new Wallet(signer, services)
    this.initialized = false
    this.storageManager = storageManager
    this.wallet = wallet
    this.identityKey = keyDeriver.identityKey
    let networkPreset: LookupNetworkPreset = 'mainnet'
    if (chain === 'test') networkPreset = 'testnet'
    if (chain === 'ttn') networkPreset = 'teratestnet'
    this.lookupResolverConfig ??= { networkPreset }
  }

  /**
   * Initializes the wallet asynchronously.
   */
  async init(): Promise<void> {
    const client = new StorageClient(this.wallet, this.storageURL)
    await client.makeAvailable()
    await this.storageManager.addWalletStorageProvider(client)
    this.initialized = true
  }

  /**
   * Utility function to create multiple advertisements in a single transaction.
   * @param adsData Array of advertisement details.
   * @returns The Tagged BEEF for the created advertisement
   * @throws Will throw an error if the locking key is invalid.
   */
  async createAdvertisements(adsData: AdvertisementData[]): Promise<TaggedBEEF> {
    if (!this.initialized) {
      throw new Error('Initialize the Advertiser using init() before use.')
    }
    if (!Array.isArray(adsData) || adsData.length === 0 || adsData.length > MAX_ADVERTISEMENTS) {
      throw new Error(
        `Advertisements must be a non-empty array of at most ${MAX_ADVERTISEMENTS} entries`
      )
    }
    if (!isAdvertisableURI(this.advertisableURI)) {
      throw new Error(
        `Refusing to create advertisements for non-advertisable URI: ${this.advertisableURI}`
      )
    }

    const pushdrop = new PushDrop(this.wallet)
    const outputs = []
    const verifiedProtocols: DiscoveryProtocol[] = []
    const uniqueAdvertisements = new Set<string>()
    for (let index = 0; index < adsData.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(adsData, index)) {
        throw new Error('Advertisements must be a dense array')
      }
      const ad = plainDataRecord(adsData[index], `Advertisement data ${index}`)
      const protocol = discoveryProtocol(ad.protocol, `Advertisement data ${index} protocol`)
      const topicOrServiceName = ad.topicOrServiceName
      if (
        typeof topicOrServiceName !== 'string' ||
        !isValidTopicOrServiceName(topicOrServiceName) ||
        !topicOrServiceName.startsWith(protocolNamePrefix[protocol])
      ) {
        throw new Error(
          `Refusing to create ${protocol} advertisement with invalid topic or service name: ${String(topicOrServiceName)}`
        )
      }
      const advertisementKey = `${protocol}:${topicOrServiceName}`
      if (uniqueAdvertisements.has(advertisementKey)) {
        throw new Error(
          `Refusing to create duplicate ${protocol} advertisement for ${topicOrServiceName}`
        )
      }
      uniqueAdvertisements.add(advertisementKey)

      const lockingScript = await pushdrop.lock(
        [
          toArray(protocol, 'utf8'),
          toArray(this.identityKey, 'hex'),
          toArray(this.advertisableURI, 'utf8'),
          toArray(topicOrServiceName, 'utf8')
        ],
        protocolID(protocol),
        '1',
        'anyone',
        true
      )
      const authenticated = await this.authenticateAdvertisement(lockingScript, protocol)
      if (
        authenticated.identityKey !== this.identityKey ||
        authenticated.domain !== this.advertisableURI ||
        authenticated.topicOrService !== topicOrServiceName
      ) {
        throw new Error('Wallet created an advertisement that does not match the requested data')
      }
      console.log(`Creating advertisement for ${topicOrServiceName} at ${this.advertisableURI}`)
      outputs.push({
        outputDescription: `${protocol} advertisement of ${topicOrServiceName}`,
        satoshis: AD_TOKEN_VALUE,
        lockingScript: lockingScript.toHex()
      })
      verifiedProtocols.push(protocol)
    }

    const transaction = await completeBoundAction(this.wallet, {
      outputs,
      description: 'SHIP/SLAP Advertisement Issuance'
    })

    return {
      beef: transaction.toBEEF(),
      topics: [
        ...new Set(verifiedProtocols.map(protocol => (protocol === 'SHIP' ? 'tm_ship' : 'tm_slap')))
      ]
    }
  }

  /**
   * Finds this wallet identity's authenticated SHIP or SLAP advertisements.
   * Lookup results owned by another identity, carrying a forged signature, or
   * not bound to their returned transaction output are ignored.
   * @param protocol - Whether SHIP or SLAP advertisements should be returned.
   * @returns A promise that resolves to an array of advertisements.
   */
  async findAllAdvertisements(protocol: 'SHIP' | 'SLAP'): Promise<Advertisement[]> {
    if (!this.initialized) {
      throw new Error('Initialize the Advertiser using init() before use.')
    }
    const expectedProtocol = discoveryProtocol(protocol, 'Advertisement protocol')
    const resolver = new LookupResolver(this.lookupResolverConfig)
    const advertisements: Advertisement[] = []
    let lookupAnswer
    try {
      lookupAnswer = await resolver.query({
        service: expectedProtocol === 'SHIP' ? 'ls_ship' : 'ls_slap',
        query: {
          identityKey: this.identityKey
        }
      })
    } catch (e) {
      console.warn(`Error finding ${expectedProtocol} advertisements`, e)
      return advertisements
    }
    let answer: Record<string, unknown>
    try {
      answer = plainDataRecord(lookupAnswer, 'Lookup answer')
    } catch (error) {
      console.error('Failed to validate advertisement lookup answer:', error)
      return advertisements
    }
    if (answer.type !== 'output-list') return advertisements
    if (!Array.isArray(answer.outputs) || answer.outputs.length > MAX_ADVERTISEMENTS) {
      console.error('Failed to validate advertisement lookup answer: invalid output set')
      return advertisements
    }

    let totalBeefBytes = 0
    const seenOutpoints = new Set<string>()
    for (let index = 0; index < answer.outputs.length; index++) {
      try {
        if (!Object.prototype.hasOwnProperty.call(answer.outputs, index)) {
          throw new Error('Lookup outputs must be dense')
        }
        const output = plainDataRecord(answer.outputs[index], `Lookup output ${index}`)
        const beef = boundedBEEF(output.beef, `Lookup output ${index} BEEF`)
        totalBeefBytes += beef.length
        if (totalBeefBytes > MAX_TOTAL_ADVERTISEMENT_BEEF_BYTES) {
          console.error('Advertisement lookup BEEF exceeded its total byte budget')
          return advertisements
        }
        const selectedIndex = outputIndex(output.outputIndex, `Lookup output ${index} index`)
        const transaction = Transaction.fromBEEF(beef)
        const txid = transaction.id('hex').toLowerCase()
        if (
          output.txid !== undefined &&
          (typeof output.txid !== 'string' || output.txid.toLowerCase() !== txid)
        ) {
          throw new Error('Lookup output transaction ID does not match its BEEF')
        }
        const selectedOutput = transaction.outputs[selectedIndex]
        if (selectedOutput == null || selectedOutput.satoshis !== AD_TOKEN_VALUE) {
          throw new Error('Lookup output is not a one-satoshi advertisement token')
        }
        const advertisement = await this.authenticateAdvertisement(
          selectedOutput.lockingScript,
          expectedProtocol
        )
        if (advertisement.identityKey.toLowerCase() !== this.identityKey.toLowerCase()) {
          throw new Error('Lookup output belongs to a different advertiser identity')
        }
        const outpoint = `${txid}.${selectedIndex}`
        if (seenOutpoints.has(outpoint)) continue
        seenOutpoints.add(outpoint)
        console.log(
          `Found current advertisement of ${advertisement.topicOrService} at ${advertisement.domain}`
        )
        advertisements.push({
          ...advertisement,
          beef: [...beef],
          outputIndex: selectedIndex
        })
      } catch (error) {
        console.error('Failed to parse advertisement output:', error)
      }
    }

    return advertisements
  }

  /**
   * Revokes an existing advertisement.
   * @param advertisements - The advertisements to revoke, either SHIP or SLAP.
   * @returns A promise that resolves to the revoked advertisement as TaggedBEEF.
   */
  async revokeAdvertisements(advertisements: Advertisement[]): Promise<TaggedBEEF> {
    if (!Array.isArray(advertisements) || advertisements.length === 0) {
      throw new Error('Must provide advertisements to revoke!')
    }
    if (advertisements.length > MAX_ADVERTISEMENTS) {
      throw new Error(`Cannot revoke more than ${MAX_ADVERTISEMENTS} advertisements at once`)
    }
    if (!this.initialized) {
      throw new Error('Initialize the Advertiser using init() before use.')
    }
    const inputBeef = new Beef()
    const txInputs: CreateActionInput[] = []
    const inputSigners: Record<
      string,
      (transaction: Transaction, inputIndex: number) => Promise<string>
    > = {}
    const verifiedProtocols: DiscoveryProtocol[] = []
    const seenOutpoints = new Set<string>()
    let totalBeefBytes = 0
    const pushdrop = new PushDrop(this.wallet)
    for (let index = 0; index < advertisements.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(advertisements, index)) {
        throw new Error('Advertisements must be a dense array')
      }
      const advertisement = plainDataRecord(advertisements[index], `Advertisement ${index}`)
      if (advertisement.beef === undefined || advertisement.outputIndex === undefined) {
        throw new Error('Advertisement to revoke must contain tagged beef!')
      }
      const beef = boundedBEEF(advertisement.beef, `Advertisement ${index} BEEF`)
      totalBeefBytes += beef.length
      if (totalBeefBytes > MAX_TOTAL_ADVERTISEMENT_BEEF_BYTES) {
        throw new Error('Advertisement BEEF exceeded its total byte budget')
      }
      const selectedIndex = outputIndex(
        advertisement.outputIndex,
        `Advertisement ${index} output index`
      )
      const advertisementTx = Transaction.fromBEEF(beef)
      const adTxid = advertisementTx.id('hex').toLowerCase()
      const sourceOutput = advertisementTx.outputs[selectedIndex]
      if (sourceOutput == null || sourceOutput.satoshis !== AD_TOKEN_VALUE) {
        throw new Error('Advertisement to revoke must identify a one-satoshi token output')
      }
      const claimedProtocol = discoveryProtocol(
        advertisement.protocol,
        `Advertisement ${index} protocol`
      )
      const authenticated = await this.authenticateAdvertisement(
        sourceOutput.lockingScript,
        claimedProtocol
      )
      if (
        authenticated.identityKey.toLowerCase() !== this.identityKey.toLowerCase() ||
        typeof advertisement.identityKey !== 'string' ||
        advertisement.identityKey.toLowerCase() !== authenticated.identityKey.toLowerCase() ||
        advertisement.domain !== authenticated.domain ||
        advertisement.topicOrService !== authenticated.topicOrService
      ) {
        throw new Error('Advertisement metadata does not match an owned authenticated token')
      }
      const outpoint = `${adTxid}.${selectedIndex}`
      if (seenOutpoints.has(outpoint)) {
        throw new Error('Cannot revoke the same advertisement outpoint more than once')
      }
      seenOutpoints.add(outpoint)
      inputBeef.mergeBeef(beef)
      txInputs.push({
        outpoint,
        inputDescription: `Revoke a ${claimedProtocol} advertisement for ${authenticated.topicOrService}`,
        unlockingScriptLength: 73
      })
      const unlocker = pushdrop.unlock(
        protocolID(claimedProtocol),
        '1',
        'anyone',
        'all',
        false,
        sourceOutput.satoshis,
        sourceOutput.lockingScript
      )
      inputSigners[outpoint] = async (transaction, inputIndex) =>
        (await unlocker.sign(transaction, inputIndex)).toHex()
      verifiedProtocols.push(claimedProtocol)
      console.log(
        `Revoking advertisement ${outpoint} for ${authenticated.topicOrService} at ${authenticated.domain}`
      )
    }

    const revokeTx = await completeBoundAction(
      this.wallet,
      {
        inputBEEF: inputBeef.toBinary(),
        inputs: txInputs,
        description: 'Revoke SHIP/SLAP advertisements'
      },
      { inputSigners }
    )
    return {
      beef: revokeTx.toBEEF(),
      topics: [
        ...new Set(verifiedProtocols.map(protocol => (protocol === 'SHIP' ? 'tm_ship' : 'tm_slap')))
      ]
    }
  }

  /**
   * Structurally parses a canonical advertisement from the provided output script.
   * This synchronous compatibility method does not verify the token signature;
   * security-sensitive callers must use a trusted admission result. This class's
   * create, find, and revoke flows perform cryptographic verification internally.
   * @param outputScript - The output script to parse.
   * @returns An Advertisement object if the script matches the expected format, otherwise throws an error.
   */
  parseAdvertisement(outputScript: Script): Advertisement {
    try {
      if (!(outputScript instanceof Script)) throw new Error('Invalid output script')
      const result = decodeCanonicalPushDrop(LockingScript.fromHex(outputScript.toHex()), {
        fieldCount: 5,
        maximumFieldBytes: MAX_DISCOVERY_FIELD_BYTES,
        maximumPayloadBytes: MAX_DISCOVERY_PAYLOAD_BYTES
      })

      const protocol = toUTF8Strict(result.fields[0])
      if (protocol !== 'SHIP' && protocol !== 'SLAP') {
        throw new Error('Invalid protocol type!')
      }

      const identityKey = toHex(result.fields[1])
      if (PublicKey.fromString(identityKey).toString() !== identityKey) {
        throw new Error('Invalid identity key!')
      }
      const domain = toUTF8Strict(result.fields[2])
      if (!isAdvertisableURI(domain)) throw new Error('Invalid advertisable URI!')
      const topicOrService = toUTF8Strict(result.fields[3])
      if (
        !isValidTopicOrServiceName(topicOrService) ||
        !topicOrService.startsWith(protocolNamePrefix[protocol])
      ) {
        throw new Error('Invalid topic or service name!')
      }

      // Construct a unified Advertisement object
      return {
        protocol,
        identityKey,
        domain,
        topicOrService
      }
    } catch (error) {
      console.error('Error parsing advertisement:', error)
      throw new Error('Error parsing advertisement!')
    }
  }

  /** Cryptographically authenticates a structurally valid advertisement. */
  private async authenticateAdvertisement(
    lockingScript: LockingScript,
    protocol: DiscoveryProtocol
  ): Promise<Advertisement> {
    if (!(await isAdmissibleDiscoveryOutput(lockingScript, protocol))) {
      throw new Error(`Invalid or unauthenticated ${protocol} advertisement`)
    }
    const advertisement = this.parseAdvertisement(lockingScript)
    if (advertisement.protocol !== protocol) {
      throw new Error(`Advertisement does not match the requested ${protocol} protocol`)
    }
    return advertisement
  }
}
