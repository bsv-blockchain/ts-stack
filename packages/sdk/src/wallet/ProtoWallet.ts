import { KeyDeriver, KeyDeriverApi } from './KeyDeriver.js'
import CachedKeyDeriver from './CachedKeyDeriver.js'
import {
  Hash,
  ECDSA,
  BigNumber,
  Signature,
  Schnorr,
  PublicKey,
  Point,
  PrivateKey,
  SymmetricKey,
  readyAsyncCryptoBackend,
  isAsyncCryptoDigest,
  validateAsyncCryptoBytes
} from '../primitives/index.js'
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
  WalletEncryptResult
} from './Wallet.interfaces.js'
import { constantTimeEquals, toArray } from '../primitives/utils.js'

function keyDeriverOrThrow(keyDeriver?: KeyDeriverApi): KeyDeriverApi {
  return (
    keyDeriver ??
    (() => {
      throw new Error('keyDeriver is undefined')
    })()
  )
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
    if (args.identityKey) {
      const rootKey = keyDeriverOrThrow(this.keyDeriver).rootKey
      const backend = readyAsyncCryptoBackend('publicKeyFromPrivate')
      if (backend !== undefined) {
        const publicKey = validateAsyncCryptoBytes(
          'publicKeyFromPrivate',
          await backend.publicKeyFromPrivate(Uint8Array.from(rootKey.toArray('be', 32))),
          33
        )
        return {
          publicKey: PublicKey.fromDER(Array.from(publicKey)).toString()
        }
      }
      return { publicKey: rootKey.toPublicKey().toString() }
    } else {
      if (args.protocolID == null || args.keyID == null || args.keyID === '') {
        throw new Error('protocolID and keyID are required if identityKey is false or undefined.')
      }
      return {
        publicKey: (await derivePublicKey(keyDeriverOrThrow(this.keyDeriver), args)).toString()
      }
    }
  }

  async revealCounterpartyKeyLinkage(
    args: RevealCounterpartyKeyLinkageArgs
  ): Promise<RevealCounterpartyKeyLinkageResult> {
    const { publicKey: identityKey } = await this.getPublicKey({
      identityKey: true
    })
    if (this.keyDeriver == null) {
      throw new Error('keyDeriver is undefined')
    }
    const linkage = this.keyDeriver.revealCounterpartySecret(args.counterparty)
    const linkageProof = new Schnorr().generateProof(
      this.keyDeriver.rootKey,
      this.keyDeriver.rootKey.toPublicKey(),
      PublicKey.fromString(args.counterparty),
      Point.fromDER(linkage)
    )
    const linkageProofBin = [
      ...linkageProof.R.encode(true),
      ...linkageProof.SPrime.encode(true),
      ...linkageProof.z.toArray('be', 32)
    ] as number[]
    const revelationTime = new Date().toISOString()
    const { ciphertext: encryptedLinkage } = await this.encrypt({
      plaintext: linkage,
      protocolID: [2, 'counterparty linkage revelation'],
      keyID: revelationTime,
      counterparty: args.verifier
    })
    const { ciphertext: encryptedLinkageProof } = await this.encrypt({
      plaintext: linkageProofBin,
      protocolID: [2, 'counterparty linkage revelation'],
      keyID: revelationTime,
      counterparty: args.verifier
    })
    return {
      prover: identityKey,
      verifier: args.verifier,
      counterparty: args.counterparty,
      revelationTime,
      encryptedLinkage,
      encryptedLinkageProof
    }
  }

  async revealSpecificKeyLinkage(
    args: RevealSpecificKeyLinkageArgs
  ): Promise<RevealSpecificKeyLinkageResult> {
    const { publicKey: identityKey } = await this.getPublicKey({
      identityKey: true
    })
    if (this.keyDeriver == null) {
      throw new Error('keyDeriver is undefined')
    }
    const linkage = this.keyDeriver.revealSpecificSecret(
      args.counterparty,
      args.protocolID,
      args.keyID
    )
    const { ciphertext: encryptedLinkage } = await this.encrypt({
      plaintext: linkage,
      protocolID: [2, `specific linkage revelation ${args.protocolID[0]} ${args.protocolID[1]}`],
      keyID: args.keyID,
      counterparty: args.verifier
    })
    const { ciphertext: encryptedLinkageProof } = await this.encrypt({
      plaintext: [0], // Proof type 0, no proof provided
      protocolID: [2, `specific linkage revelation ${args.protocolID[0]} ${args.protocolID[1]}`],
      keyID: args.keyID,
      counterparty: args.verifier
    })
    return {
      prover: identityKey,
      verifier: args.verifier,
      counterparty: args.counterparty,
      protocolID: args.protocolID,
      keyID: args.keyID,
      encryptedLinkage,
      encryptedLinkageProof,
      proofType: 0
    }
  }

  async encrypt(args: WalletEncryptArgs): Promise<WalletEncryptResult> {
    const key = await deriveSymmetricKey(
      keyDeriverOrThrow(this.keyDeriver),
      args.protocolID,
      args.keyID,
      args.counterparty ?? 'self'
    )
    return { ciphertext: key.encrypt(args.plaintext) as number[] }
  }

  async decrypt(args: WalletDecryptArgs, _originator?: string): Promise<WalletDecryptResult> {
    const key = await deriveSymmetricKey(
      keyDeriverOrThrow(this.keyDeriver),
      args.protocolID,
      args.keyID,
      args.counterparty ?? 'self'
    )
    return { plaintext: key.decrypt(args.ciphertext) as number[] }
  }

  async createHmac(args: CreateHmacArgs): Promise<CreateHmacResult> {
    const key = await deriveSymmetricKey(
      keyDeriverOrThrow(this.keyDeriver),
      args.protocolID,
      args.keyID,
      args.counterparty ?? 'self'
    )
    return { hmac: Hash.sha256hmac(key.toArray(), args.data) }
  }

  async verifyHmac(args: VerifyHmacArgs): Promise<VerifyHmacResult> {
    const key = await deriveSymmetricKey(
      keyDeriverOrThrow(this.keyDeriver),
      args.protocolID,
      args.keyID,
      args.counterparty ?? 'self'
    )
    const computed = Hash.sha256hmac(key.toArray(), args.data)
    const provided = args.hmac

    const valid = constantTimeEquals(toArray(computed), toArray(provided))
    if (!valid) {
      const e = new Error('HMAC is not valid') as Error & { code: string }
      e.code = 'ERR_INVALID_HMAC'
      throw e
    }
    return { valid }
  }

  async createSignature(args: CreateSignatureArgs): Promise<CreateSignatureResult> {
    if (args.hashToDirectlySign == null && args.data == null) {
      throw new Error('args.data or args.hashToDirectlySign must be valid')
    }

    const hash: number[] = args.hashToDirectlySign ?? Hash.sha256(args.data ?? [])
    const key = derivePrivateKey(
      keyDeriverOrThrow(this.keyDeriver),
      args.protocolID,
      args.keyID,
      args.counterparty ?? 'anyone'
    )

    const backend = isAsyncCryptoDigest(hash) ? readyAsyncCryptoBackend('signDigest') : undefined
    const signature =
      backend === undefined
        ? ECDSA.sign(new BigNumber(hash), key, true)
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
    if (args.hashToDirectlyVerify == null && args.data == null) {
      throw new Error('args.data or args.hashToDirectlyVerify must be valid')
    }

    const hash: number[] = args.hashToDirectlyVerify ?? Hash.sha256(args.data ?? [])
    const key = await derivePublicKey(keyDeriverOrThrow(this.keyDeriver), args)
    const parsedSignature = Signature.fromDER(args.signature)
    const backend = isAsyncCryptoDigest(hash) ? readyAsyncCryptoBackend('verifyDigest') : undefined
    const valid =
      backend === undefined
        ? ECDSA.verify(new BigNumber(hash), parsedSignature, key)
        : await backend.verifyDigest(
            Uint8Array.from(key.encode(true) as number[]),
            Uint8Array.from(hash),
            Uint8Array.from(parsedSignature.toDER() as number[])
          )

    if (!valid) {
      const e = new Error('Signature is not valid') as Error & { code: string }
      e.code = 'ERR_INVALID_SIGNATURE'
      throw e
    }

    return { valid }
  }
}

export default ProtoWallet
