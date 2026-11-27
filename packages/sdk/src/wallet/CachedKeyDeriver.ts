import Point from '../primitives/Point.js'
import PrivateKey from '../primitives/PrivateKey.js'
import PublicKey from '../primitives/PublicKey.js'
import SymmetricKey from '../primitives/SymmetricKey.js'
import { Counterparty, KeyDeriver, KeyDeriverApi, PrivateKeyDerivation } from './KeyDeriver.js'
import { WalletProtocol } from './Wallet.interfaces.js'

type CachedKeyValue = PublicKey | PrivateKey | SymmetricKey | Point | number[]

function isThenable<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === 'object' &&
    value != null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

function cloneCachedKeyValue(value: CachedKeyValue): CachedKeyValue {
  if (value instanceof PublicKey) return new PublicKey(value)
  if (value instanceof PrivateKey) return new PrivateKey(value)
  if (value instanceof SymmetricKey) return new SymmetricKey(value.toArray())
  if (value instanceof Point) return new Point(value.getX(), value.getY())
  return Array.from(value)
}

/**
 * A cached version of KeyDeriver that caches the results of key derivation methods.
 * This is useful for optimizing performance when the same keys are derived multiple times.
 * It supports configurable cache size with sane defaults and maintains cache entries using LRU (Least Recently Used) eviction policy.
 */
export default class CachedKeyDeriver implements KeyDeriverApi {
  private readonly keyDeriver: KeyDeriverApi
  private readonly cache: Map<string, CachedKeyValue>
  private readonly maxCacheSize: number

  /**
   * The root key from which all other keys are derived.
   */
  rootKey: PrivateKey

  /**
   * The identity of this key deriver which is normally the public key associated with the `rootKey`
   */
  identityKey: string

  /**
   * Initializes the CachedKeyDeriver instance with a root private key and optional cache settings.
   * @param {PrivateKey | 'anyone'} rootKey - The root private key or the string 'anyone'.
   * @param {Object} [options] - Optional settings for the cache.
   * @param {number} [options.maxCacheSize=1000] - The maximum number of entries to store in the cache.
   */
  constructor(rootKey: PrivateKey | 'anyone', options?: { maxCacheSize?: number }) {
    if (rootKey === 'anyone') {
      this.rootKey = new PrivateKey(1)
    } else {
      this.rootKey = rootKey
    }
    this.keyDeriver = new KeyDeriver(
      this.rootKey,
      (priv, pub, point) => {
        this.cacheSet(`${priv.toString()}-${pub.toString()}`, point)
      },
      (priv, pub) => {
        return this.cacheGet(`${priv.toString()}-${pub.toString()}`) as Point | undefined
      }
    )
    this.identityKey = this.rootKey.toPublicKey().toString()
    this.cache = new Map<string, CachedKeyValue>()
    const maxCacheSize = options?.maxCacheSize
    this.maxCacheSize =
      maxCacheSize != null && !Number.isNaN(maxCacheSize) && maxCacheSize > 0 ? maxCacheSize : 1000
  }

  /**
   * Derives a public key based on protocol ID, key ID, and counterparty.
   * Caches the result for future calls with the same parameters.
   * @param {WalletProtocol} protocolID - The protocol ID including a security level and protocol name.
   * @param {string} keyID - The key identifier.
   * @param {Counterparty} counterparty - The counterparty's public key or a predefined value ('self' or 'anyone').
   * @param {boolean} [forSelf=false] - Whether deriving for self.
   * @returns {PublicKey} - The derived public key.
   */
  derivePublicKey(
    protocolID: WalletProtocol,
    keyID: string,
    counterparty: Counterparty,
    forSelf: boolean = false
  ): PublicKey {
    const cacheKey = this.generateCacheKey(
      'derivePublicKey',
      protocolID,
      keyID,
      counterparty,
      forSelf
    )
    if (this.cache.has(cacheKey)) {
      const cachedValue = this.cacheGet(cacheKey)
      if (cachedValue === undefined) {
        throw new Error('Cached value is undefined')
      }
      return cachedValue as PublicKey
    } else {
      const result = this.keyDeriver.derivePublicKey(protocolID, keyID, counterparty, forSelf)
      this.cacheSet(cacheKey, result)
      return result
    }
  }

  async derivePublicKeyAsync(
    protocolID: WalletProtocol,
    keyID: string,
    counterparty: Counterparty,
    forSelf: boolean = false
  ): Promise<PublicKey> {
    const cacheKey = this.generateCacheKey(
      'derivePublicKey',
      protocolID,
      keyID,
      counterparty,
      forSelf
    )
    const cachedValue = this.cacheGet(cacheKey)
    if (cachedValue !== undefined) return cachedValue as PublicKey
    const derivePublicKeyAsync = this.keyDeriver.derivePublicKeyAsync
    if (derivePublicKeyAsync == null) throw new Error('key deriver does not implement derivePublicKeyAsync')
    const result = await derivePublicKeyAsync.call(this.keyDeriver, protocolID, keyID, counterparty, forSelf)
    this.cacheSet(cacheKey, result)
    return result
  }

  /**
   * Derives a private key based on protocol ID, key ID, and counterparty.
   * Caches the result for future calls with the same parameters.
   * @param {WalletProtocol} protocolID - The protocol ID including a security level and protocol name.
   * @param {string} keyID - The key identifier.
   * @param {Counterparty} counterparty - The counterparty's public key or a predefined value ('self' or 'anyone').
   * @returns {PrivateKey} - The derived private key.
   */
  derivePrivateKey(
    protocolID: WalletProtocol,
    keyID: string,
    counterparty: Counterparty
  ): PrivateKey {
    const cacheKey = this.generateCacheKey('derivePrivateKey', protocolID, keyID, counterparty)
    if (this.cache.has(cacheKey)) {
      const cachedValue = this.cacheGet(cacheKey)
      if (cachedValue === undefined) {
        throw new Error('Cached value is undefined')
      }
      return cachedValue as PrivateKey
    } else {
      const result = this.keyDeriver.derivePrivateKey(protocolID, keyID, counterparty)
      this.cacheSet(cacheKey, result)
      return result
    }
  }

  derivePrivateKeys(
    derivations: readonly PrivateKeyDerivation[]
  ): PrivateKey[] | Promise<PrivateKey[]> {
    const results: PrivateKey[] = []
    const missing: PrivateKeyDerivation[] = []
    const missingIndexes: number[] = []
    const missingCacheKeys: string[] = []
    for (let index = 0; index < derivations.length; index++) {
      const derivation = derivations[index]
      const cacheKey = this.generateCacheKey(
        'derivePrivateKey',
        derivation.protocolID,
        derivation.keyID,
        derivation.counterparty
      )
      const cached = this.cacheGet(cacheKey)
      if (cached instanceof PrivateKey) {
        results[index] = cached
      } else {
        missing.push(derivation)
        missingIndexes.push(index)
        missingCacheKeys.push(cacheKey)
      }
    }
    if (missing.length === 0) return results
    const derive = this.keyDeriver.derivePrivateKeys
    if (derive == null) throw new Error('key deriver does not implement derivePrivateKeys')
    const derived = derive.call(this.keyDeriver, missing)
    if (isThenable(derived)) {
      // Cache only after fulfillment. A rejection must not be stored.
      return derived.then(keys =>
        this.storeDerivedKeys(keys, missingIndexes, missingCacheKeys, results)
      )
    }
    return this.storeDerivedKeys(derived, missingIndexes, missingCacheKeys, results)
  }

  private storeDerivedKeys(
    keys: PrivateKey[],
    missingIndexes: number[],
    missingCacheKeys: string[],
    results: PrivateKey[]
  ): PrivateKey[] {
    if (keys.length !== missingIndexes.length || keys.some(key => !(key instanceof PrivateKey))) {
      throw new Error('derivePrivateKeys returned an unexpected result')
    }
    for (let index = 0; index < keys.length; index++) {
      results[missingIndexes[index]] = keys[index]
      this.cacheSet(missingCacheKeys[index], keys[index])
    }
    return results
  }

  /**
   * Derives a symmetric key based on protocol ID, key ID, and counterparty.
   * Caches the result for future calls with the same parameters.
   * @param {WalletProtocol} protocolID - The protocol ID including a security level and protocol name.
   * @param {string} keyID - The key identifier.
   * @param {Counterparty} counterparty - The counterparty's public key or a predefined value ('self' or 'anyone').
   * @returns {SymmetricKey} - The derived symmetric key.
   * @throws {Error} - Throws an error if attempting to derive a symmetric key for 'anyone'.
   */
  deriveSymmetricKey(
    protocolID: WalletProtocol,
    keyID: string,
    counterparty: Counterparty
  ): SymmetricKey {
    const cacheKey = this.generateCacheKey('deriveSymmetricKey', protocolID, keyID, counterparty)
    if (this.cache.has(cacheKey)) {
      const cachedValue = this.cacheGet(cacheKey)
      if (cachedValue === undefined) {
        throw new Error('Cached value is undefined')
      }
      return cachedValue as SymmetricKey
    } else {
      const result = this.keyDeriver.deriveSymmetricKey(protocolID, keyID, counterparty)
      this.cacheSet(cacheKey, result)
      return result
    }
  }

  async deriveSymmetricKeyAsync(
    protocolID: WalletProtocol,
    keyID: string,
    counterparty: Counterparty
  ): Promise<SymmetricKey> {
    const cacheKey = this.generateCacheKey('deriveSymmetricKey', protocolID, keyID, counterparty)
    const cachedValue = this.cacheGet(cacheKey)
    if (cachedValue !== undefined) return cachedValue as SymmetricKey
    const deriveSymmetricKeyAsync = this.keyDeriver.deriveSymmetricKeyAsync
    if (deriveSymmetricKeyAsync == null) {
      throw new Error('key deriver does not implement deriveSymmetricKeyAsync')
    }
    const result = await deriveSymmetricKeyAsync.call(this.keyDeriver, protocolID, keyID, counterparty)
    this.cacheSet(cacheKey, result)
    return result
  }

  /**
   * Reveals the shared secret between the root key and the counterparty.
   * Caches the result for future calls with the same parameters.
   * @param {Counterparty} counterparty - The counterparty's public key or a predefined value ('self' or 'anyone').
   * @returns {number[]} - The shared secret as a number array.
   * @throws {Error} - Throws an error if attempting to reveal a shared secret for 'self'.
   */
  revealCounterpartySecret(counterparty: Counterparty): number[] {
    const cacheKey = this.generateCacheKey('revealCounterpartySecret', counterparty)
    if (this.cache.has(cacheKey)) {
      const cachedValue = this.cacheGet(cacheKey)
      if (cachedValue === undefined) {
        throw new Error('Cached value is undefined')
      }
      return cachedValue as number[]
    } else {
      const result = this.keyDeriver.revealCounterpartySecret(counterparty)
      this.cacheSet(cacheKey, result)
      return result
    }
  }

  /**
   * Reveals the specific key association for a given protocol ID, key ID, and counterparty.
   * Caches the result for future calls with the same parameters.
   * @param {Counterparty} counterparty - The counterparty's public key or a predefined value ('self' or 'anyone').
   * @param {WalletProtocol} protocolID - The protocol ID including a security level and protocol name.
   * @param {string} keyID - The key identifier.
   * @returns {number[]} - The specific key association as a number array.
   */
  revealSpecificSecret(
    counterparty: Counterparty,
    protocolID: WalletProtocol,
    keyID: string
  ): number[] {
    const cacheKey = this.generateCacheKey('revealSpecificSecret', counterparty, protocolID, keyID)
    if (this.cache.has(cacheKey)) {
      const cachedValue = this.cacheGet(cacheKey)
      if (cachedValue === undefined) {
        throw new Error('Cached value is undefined')
      }
      return cachedValue as number[]
    } else {
      const result = this.keyDeriver.revealSpecificSecret(counterparty, protocolID, keyID)
      this.cacheSet(cacheKey, result)
      return result
    }
  }

  /**
   * Generates a unique cache key based on the method name and input parameters.
   * @param {string} methodName - The name of the method.
   * @param {...any} args - The arguments passed to the method.
   * @returns {string} - The generated cache key.
   */
  private generateCacheKey(
    methodName: string,
    ...args: Array<
      string | number | boolean | PublicKey | PrivateKey | Counterparty | WalletProtocol
    >
  ): string {
    const serializedArgs = args.map(arg => this.serializeArgument(arg)).join('|')
    return `${methodName}|${serializedArgs}`
  }

  /**
   * Serializes an argument to a string for use in a cache key.
   * @param {any} arg - The argument to serialize.
   * @returns {string} - The serialized argument.
   */
  private serializeArgument(
    arg:
      | string
      | number
      | boolean
      | PublicKey
      | PrivateKey
      | Counterparty
      | WalletProtocol
      | object
      | null
  ): string {
    if (arg instanceof PublicKey || arg instanceof PrivateKey) {
      return arg.toString()
    } else if (Array.isArray(arg)) {
      return arg.map(item => this.serializeArgument(item)).join(',')
    } else if (typeof arg === 'object' && arg !== null) {
      return JSON.stringify(arg)
    } else {
      return String(arg as string | number | boolean)
    }
  }

  /**
   * Retrieves an item from the cache and updates its position to reflect recent use.
   * @param {string} cacheKey - The key of the cached item.
   * @returns {any} - The cached value.
   */
  private cacheGet(cacheKey: string): CachedKeyValue | undefined {
    const value = this.cache.get(cacheKey)
    // Update the entry to reflect recent use
    this.cache.delete(cacheKey)
    if (value !== undefined) {
      this.cache.set(cacheKey, value)
    }
    return value === undefined ? undefined : cloneCachedKeyValue(value)
  }

  /**
   * Adds an item to the cache and evicts the least recently used item if necessary.
   * @param {string} cacheKey - The key of the item to cache.
   * @param {any} value - The value to cache.
   */
  private cacheSet(cacheKey: string, value: CachedKeyValue): void {
    if (this.cache.size >= this.maxCacheSize) {
      // Evict the least recently used item (first item in Map)
      const firstKey = this.cache.keys().next().value
      if (firstKey !== undefined) this.cache.delete(firstKey)
    }
    this.cache.set(cacheKey, cloneCachedKeyValue(value))
  }
}
