import { KeyDeriver, KeyDeriverApi } from './KeyDeriver.js'
import CachedKeyDeriver from './CachedKeyDeriver.js'
import { sha256, sha256hmac } from '../primitives/Hash.js'
import { sign, verify } from '../primitives/ECDSA.js'
import BigNumber from '../primitives/BigNumber.js'
import Signature from '../primitives/Signature.js'
import Schnorr from '../primitives/Schnorr.js'
import PublicKey from '../primitives/PublicKey.js'
import Point from '../primitives/Point.js'
import PrivateKey from '../primitives/PrivateKey.js'
import SymmetricKey from '../primitives/SymmetricKey.js'
import {
  readyAsyncCryptoBackend,
  isAsyncCryptoDigest,
  validateAsyncCryptoBytes
} from '../primitives/AsyncCryptoBackend.js'
import {
  CreateHmacArgs,
  CreateHmacResult,
  CreateSignatureArgs,
  CreateSignatureResult,
  GetPublicKeyArgs,
  PubKeyHex,
  RevealCounterpartyKeyLinkageArgs,
  RevealCounterpartyKeyLinkageResult,
  RevealSpecificKeyLinkageArgs,
  RevealSpecificKeyLinkageResult,
  VerifyHmacArgs,
  VerifyHmacResult,
  VerifySignatureArgs,
  VerifySignatureResult,
  WalletDecryptArgs,
  WalletDecryptResult,
  WalletEncryptArgs,
  WalletEncryptResult,
  WalletProtocol
} from './Wallet.interfaces.js'
import { constantTimeEquals, toArray } from '../primitives/utils.js'
import {
  validateCreateHmacArgs,
  validateCreateSignatureArgs,
  validateGetPublicKeyArgs,
  validateRevealCounterpartyKeyLinkageArgs,
  validateRevealSpecificKeyLinkageArgs,
  validateVerifyHmacArgs,
  validateVerifySignatureArgs,
  validateWalletDecryptArgs,
  validateWalletEncryptArgs
} from './validationHelpers.js'

function snapshotProtocolID(protocolID: WalletProtocol): WalletProtocol {
  return [protocolID[0], protocolID[1]]
}

function snapshotBytes(bytes: number[]): number[] {
  return Array.from(bytes)
}

async function hashSignatureData(data: number[]): Promise<number[]> {
  const subtle = globalThis.crypto?.subtle
  if (!Array.isArray(data) || data.length < 65536 || subtle === undefined) {
    return sha256(data)
  }
  // Snapshot before yielding: a caller changing its array while native hashing
  // runs must not change the bytes used by a fallback after a host failure.
  const bytes = new Uint8Array(data)
  try {
    const digest = new Uint8Array(await subtle.digest('SHA-256', bytes))
    if (digest.length === 32) return Array.from(digest)
  } catch {
    // Some browser/mobile hosts expose Web Crypto without supporting digest.
  }
  return sha256(bytes)
}

function keyDeriverOrThrow(keyDeriver?: KeyDeriverApi): KeyDeriverApi {
  return (
    keyDeriver ??
    (() => {
      throw new Error('keyDeriver is undefined')
    })()
  )
}

async function deriveIdentityPublicKey(keyDeriver: KeyDeriverApi): Promise<PublicKey> {
  const rootKey = keyDeriver.rootKey
  const backend = readyAsyncCryptoBackend('publicKeyFromPrivate')
  if (backend !== undefined) {
    const publicKey = validateAsyncCryptoBytes(
      'publicKeyFromPrivate',
      await backend.publicKeyFromPrivate(Uint8Array.from(rootKey.toArray('be', 32))),
      33
    )
    return PublicKey.fromDER(Array.from(publicKey))
  }
  return rootKey.toPublicKey()
}

async function derivePublicKey(
  keyDeriver: KeyDeriverApi,
  args: Pick<GetPublicKeyArgs, 'protocolID' | 'keyID' | 'counterparty' | 'forSelf'>
): Promise<PublicKey> {
  const protocolID = args.protocolID
  const keyID = args.keyID
  if (protocolID == null || keyID == null) {
    throw new Error('protocolID and keyID are required')
  }
  if (keyDeriver.derivePublicKeyAsync !== undefined) {
    return await keyDeriver.derivePublicKeyAsync(
      protocolID,
      keyID,
      args.counterparty ?? 'self',
      args.forSelf
    )
  }
  return keyDeriver.derivePublicKey(protocolID, keyID, args.counterparty ?? 'self', args.forSelf)
}

function derivePrivateKey(
  keyDeriver: KeyDeriverApi,
  protocolID: Parameters<KeyDeriverApi['derivePrivateKey']>[0],
  keyID: string,
  counterparty: Parameters<KeyDeriverApi['derivePrivateKey']>[2]
): PrivateKey {
  // Scalar-only private derivation is faster in TypeScript than crossing the
  // WASM boundary, even when the optional backend is already warm.
  return keyDeriver.derivePrivateKey(protocolID, keyID, counterparty)
}

async function deriveSymmetricKey(
  keyDeriver: KeyDeriverApi,
  protocolID: Parameters<KeyDeriverApi['deriveSymmetricKey']>[0],
  keyID: string,
  counterparty: Parameters<KeyDeriverApi['deriveSymmetricKey']>[2]
): Promise<SymmetricKey> {
  if (keyDeriver.deriveSymmetricKeyAsync !== undefined) {
    return await keyDeriver.deriveSymmetricKeyAsync(protocolID, keyID, counterparty)
  }
  return keyDeriver.deriveSymmetricKey(protocolID, keyID, counterparty)
}

/**
 * A ProtoWallet is precursor to a full wallet, capable of performing all foundational cryptographic operations.
 * It can derive keys, create signatures, facilitate encryption and HMAC operations, and reveal key linkages.
 *
 * However, ProtoWallet does not create transactions, manage outputs, interact with the blockchain,
 * enable the management of identity certificates, or store any data. It is also not concerned with privileged keys.
 */
export class ProtoWallet {
  keyDeriver?: KeyDeriverApi

  constructor(rootKeyOrKeyDeriver?: PrivateKey | 'anyone' | KeyDeriverApi) {
    if (typeof (rootKeyOrKeyDeriver as KeyDeriver).identityKey !== 'string') {
      rootKeyOrKeyDeriver = new CachedKeyDeriver(rootKeyOrKeyDeriver as PrivateKey | 'anyone')
    }
    this.keyDeriver = rootKeyOrKeyDeriver as KeyDeriverApi
  }

  async getPublicKey(args: GetPublicKeyArgs): Promise<{ publicKey: PubKeyHex }> {
    validateGetPublicKeyArgs(args)
    const keyDeriver = keyDeriverOrThrow(this.keyDeriver)
    if (args.identityKey) {
      return { publicKey: (await deriveIdentityPublicKey(keyDeriver)).toString() }
    } else {
      if (args.protocolID == null || args.keyID == null || args.keyID === '') {
        throw new Error('protocolID and keyID are required if identityKey is false or undefined.')
      }
      const request = {
        protocolID: snapshotProtocolID(args.protocolID),
        keyID: args.keyID,
        counterparty: args.counterparty,
        forSelf: args.forSelf
      }
      return { publicKey: (await derivePublicKey(keyDeriver, request)).toString() }
    }
  }

  async revealCounterpartyKeyLinkage(
    args: RevealCounterpartyKeyLinkageArgs
  ): Promise<RevealCounterpartyKeyLinkageResult> {
    validateRevealCounterpartyKeyLinkageArgs(args)
    const counterparty = args.counterparty
    const verifier = args.verifier
    const keyDeriver = keyDeriverOrThrow(this.keyDeriver)
    const identityKey = (await deriveIdentityPublicKey(keyDeriver)).toString()
    const linkage = keyDeriver.revealCounterpartySecret(counterparty)
    const linkageProof = new Schnorr().generateProof(
      keyDeriver.rootKey,
      keyDeriver.rootKey.toPublicKey(),
      PublicKey.fromString(counterparty),
      Point.fromDER(linkage)
    )
    const linkageProofBin = [
      ...linkageProof.R.encode(true),
      ...linkageProof.SPrime.encode(true),
      ...linkageProof.z.toArray('be', 32)
    ] as number[]
    const revelationTime = new Date().toISOString()
    const encryptionKey = await deriveSymmetricKey(
      keyDeriver,
      [2, 'counterparty linkage revelation'],
      revelationTime,
      verifier
    )
    const encryptedLinkage = encryptionKey.encrypt(linkage) as number[]
    const encryptedLinkageProof = encryptionKey.encrypt(linkageProofBin) as number[]
    return {
      prover: identityKey,
      verifier,
      counterparty,
      revelationTime,
      encryptedLinkage,
      encryptedLinkageProof
    }
  }

  async revealSpecificKeyLinkage(
    args: RevealSpecificKeyLinkageArgs
  ): Promise<RevealSpecificKeyLinkageResult> {
    validateRevealSpecificKeyLinkageArgs(args)
    const keyDeriver = keyDeriverOrThrow(this.keyDeriver)
    const counterpartyRequest = args.counterparty
    const verifier = args.verifier
    const protocolID = snapshotProtocolID(args.protocolID)
    const keyID = args.keyID
    const identityKey = (await deriveIdentityPublicKey(keyDeriver)).toString()
    const linkage = keyDeriver.revealSpecificSecret(counterpartyRequest, protocolID, keyID)
    const revelationProtocol: WalletProtocol = [
      2,
      `specific linkage revelation ${protocolID[0]} ${protocolID[1]}`
    ]
    const encryptionKey = await deriveSymmetricKey(keyDeriver, revelationProtocol, keyID, verifier)
    const encryptedLinkage = encryptionKey.encrypt(linkage) as number[]
    const encryptedLinkageProof = encryptionKey.encrypt([0]) as number[] // Proof type 0, no proof provided
    const counterparty =
      counterpartyRequest === 'self'
        ? identityKey
        : counterpartyRequest === 'anyone'
          ? new PrivateKey(1).toPublicKey().toString()
          : counterpartyRequest
    return {
      prover: identityKey,
      verifier,
      counterparty,
      protocolID,
      keyID,
      encryptedLinkage,
      encryptedLinkageProof,
      proofType: 0
    }
  }

  async encrypt(args: WalletEncryptArgs): Promise<WalletEncryptResult> {
    validateWalletEncryptArgs(args)
    const protocolID = snapshotProtocolID(args.protocolID)
    const keyID = args.keyID
    const counterparty = args.counterparty ?? 'self'
    const plaintext = snapshotBytes(args.plaintext)
    const key = await deriveSymmetricKey(
      keyDeriverOrThrow(this.keyDeriver),
      protocolID,
      keyID,
      counterparty
    )
    return { ciphertext: key.encrypt(plaintext) as number[] }
  }

  async decrypt(args: WalletDecryptArgs, _originator?: string): Promise<WalletDecryptResult> {
    validateWalletDecryptArgs(args)
    const protocolID = snapshotProtocolID(args.protocolID)
    const keyID = args.keyID
    const counterparty = args.counterparty ?? 'self'
    const ciphertext = snapshotBytes(args.ciphertext)
    const key = await deriveSymmetricKey(
      keyDeriverOrThrow(this.keyDeriver),
      protocolID,
      keyID,
      counterparty
    )
    return { plaintext: key.decrypt(ciphertext) as number[] }
  }

  async createHmac(args: CreateHmacArgs): Promise<CreateHmacResult> {
    validateCreateHmacArgs(args)
    const protocolID = snapshotProtocolID(args.protocolID)
    const keyID = args.keyID
    const counterparty = args.counterparty ?? 'self'
    const data = snapshotBytes(args.data)
    const key = await deriveSymmetricKey(
      keyDeriverOrThrow(this.keyDeriver),
      protocolID,
      keyID,
      counterparty
    )
    return { hmac: sha256hmac(key.toArray(), data) }
  }

  async verifyHmac(args: VerifyHmacArgs): Promise<VerifyHmacResult> {
    validateVerifyHmacArgs(args)
    const protocolID = snapshotProtocolID(args.protocolID)
    const keyID = args.keyID
    const counterparty = args.counterparty ?? 'self'
    const data = snapshotBytes(args.data)
    const provided = snapshotBytes(args.hmac)
    const key = await deriveSymmetricKey(
      keyDeriverOrThrow(this.keyDeriver),
      protocolID,
      keyID,
      counterparty
    )
    const computed = sha256hmac(key.toArray(), data)

    const valid = constantTimeEquals(toArray(computed), toArray(provided))
    if (!valid) {
      const e = new Error('HMAC is not valid') as Error & { code: string }
      e.code = 'ERR_INVALID_HMAC'
      throw e
    }
    return { valid }
  }

  async createSignature(args: CreateSignatureArgs): Promise<CreateSignatureResult> {
    validateCreateSignatureArgs(args)
    const keyDeriver = keyDeriverOrThrow(this.keyDeriver)
    if (args.hashToDirectlySign == null && args.data == null) {
      throw new Error('args.data or args.hashToDirectlySign must be valid')
    }

    const protocolID = snapshotProtocolID(args.protocolID)
    const keyID = args.keyID
    const counterparty = args.counterparty ?? 'anyone'
    const directHash =
      args.hashToDirectlySign === undefined ? undefined : snapshotBytes(args.hashToDirectlySign)
    const data = args.data === undefined ? undefined : snapshotBytes(args.data)
    const hash: number[] = directHash ?? (await hashSignatureData(data ?? []))
    const key = derivePrivateKey(keyDeriver, protocolID, keyID, counterparty)

    const backend = isAsyncCryptoDigest(hash) ? readyAsyncCryptoBackend('signDigest') : undefined
    const signature =
      backend === undefined
        ? sign(new BigNumber(hash), key, true)
        : Signature.fromDER(
            Array.from(
              validateAsyncCryptoBytes(
                'signDigest',
                await backend.signDigest(
                  Uint8Array.from(key.toArray('be', 32)),
                  Uint8Array.from(hash)
                )
              )
            )
          )
    return {
      signature: signature.toDER() as number[]
    }
  }

  async verifySignature(args: VerifySignatureArgs): Promise<VerifySignatureResult> {
    validateVerifySignatureArgs(args)
    const keyDeriver = keyDeriverOrThrow(this.keyDeriver)
    if (args.hashToDirectlyVerify == null && args.data == null) {
      throw new Error('args.data or args.hashToDirectlyVerify must be valid')
    }

    const request = {
      protocolID: snapshotProtocolID(args.protocolID),
      keyID: args.keyID,
      counterparty: args.counterparty,
      forSelf: args.forSelf
    }
    const directHash =
      args.hashToDirectlyVerify === undefined ? undefined : snapshotBytes(args.hashToDirectlyVerify)
    const data = args.data === undefined ? undefined : snapshotBytes(args.data)
    const signature = snapshotBytes(args.signature)
    const hash: number[] = directHash ?? (await hashSignatureData(data ?? []))
    const key = await derivePublicKey(keyDeriver, request)
    const parsedSignature = Signature.fromDER(signature)
    const backend = isAsyncCryptoDigest(hash) ? readyAsyncCryptoBackend('verifyDigest') : undefined
    const valid =
      backend === undefined
        ? verify(new BigNumber(hash), parsedSignature, key)
        : (await backend.verifyDigest(
            Uint8Array.from(key.encode(true) as number[]),
            Uint8Array.from(hash),
            Uint8Array.from(parsedSignature.toDER() as number[])
          )) === true

    if (!valid) {
      const e = new Error('Signature is not valid') as Error & { code: string }
      e.code = 'ERR_INVALID_SIGNATURE'
      throw e
    }

    return { valid }
  }
}

export default ProtoWallet
